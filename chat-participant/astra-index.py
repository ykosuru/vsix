#!/usr/bin/env python3
"""
AstraCode Lightweight Index Builder

Builds a compact index (~1-5MB instead of 100s of MB):
- File paths and metadata
- Function/procedure definitions  
- Keywords for searching
- Full text ONLY for documents (PDF, Excel, Word)

Code files are read from disk on-demand by the extension.

Usage:
    python astra-index.py /path/to/workspace
    python astra-index.py folder1 folder2 --output .astra-index.json

For documents (optional):
    pip install pypdf2 openpyxl python-docx
"""

import os
import sys
import json
import argparse
import re
from pathlib import Path
from datetime import datetime

# Optional imports
PARSERS = {'pdf': False, 'excel': False, 'word': False}

try:
    from PyPDF2 import PdfReader
    PARSERS['pdf'] = True
except ImportError:
    pass

try:
    import openpyxl
    PARSERS['excel'] = True
except ImportError:
    pass

try:
    from docx import Document
    PARSERS['word'] = True
except ImportError:
    pass


CODE_EXTENSIONS = {
    '.tal', '.cbl', '.cob', '.cobol', '.pli', '.pco', '.cpy',
    '.java', '.py', '.js', '.ts', '.jsx', '.tsx',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
    '.sql', '.json', '.yaml', '.yml', '.xml', '.txt', '.md', '.csv'
}

DOC_EXTENSIONS = {'.pdf': 'pdf', '.xlsx': 'excel', '.xls': 'excel', '.docx': 'word'}

SKIP_DIRS = {'node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build', 'generated'}


def read_file(filepath):
    """Read text file with encoding fallback."""
    for enc in ['utf-8', 'latin-1', 'cp1252']:
        try:
            with open(filepath, 'r', encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    return None


def extract_functions(content, ext):
    """Extract function definitions from code."""
    functions = []
    lines = content.split('\n')
    
    for i, line in enumerate(lines):
        name = None
        
        if ext in ['.tal']:
            match = re.match(r'^\s*(PROC|SUBPROC)\s+(\w+)', line, re.IGNORECASE)
            if match:
                name = match.group(2)
        
        elif ext in ['.cbl', '.cob', '.cobol', '.cpy']:
            match = re.match(r'^\s{6,7}(\w[\w-]+)\s*(SECTION)?\.', line)
            if match:
                name = match.group(1)
        
        elif ext == '.java':
            match = re.match(r'^\s*(public|private|protected)?\s*(static)?\s*\w+\s+(\w+)\s*\(', line)
            if match:
                name = match.group(3)
        
        elif ext == '.py':
            match = re.match(r'^\s*(def|class)\s+(\w+)', line)
            if match:
                name = match.group(2)
        
        elif ext in ['.js', '.ts', '.jsx', '.tsx']:
            match = re.match(r'^\s*(async\s+)?function\s+(\w+)', line)
            if match:
                name = match.group(2)
            else:
                match = re.match(r'^\s*(const|let|var)\s+(\w+)\s*=\s*(async\s+)?(\(|function)', line)
                if match:
                    name = match.group(2)
        
        if name:
            functions.append({'name': name, 'line': i + 1})
    
    return functions


def extract_keywords(content, max_keywords=50):
    """Extract significant keywords for searching."""
    # Find identifiers
    words = re.findall(r'\b[A-Z][A-Z0-9_-]{2,}\b|\b[a-z][a-zA-Z0-9_]{3,}\b', content)
    
    # Count frequency
    freq = {}
    for w in words:
        w_upper = w.upper()
        freq[w_upper] = freq.get(w_upper, 0) + 1
    
    # Filter common words
    common = {'THIS', 'THAT', 'WITH', 'FROM', 'HAVE', 'BEEN', 'WERE', 'THEY', 
              'WILL', 'WOULD', 'COULD', 'SHOULD', 'RETURN', 'FUNCTION', 'CLASS',
              'PUBLIC', 'PRIVATE', 'STATIC', 'VOID', 'STRING', 'TRUE', 'FALSE',
              'NULL', 'NONE', 'IMPORT', 'EXPORT', 'CONST', 'ELSE', 'THEN', 'BEGIN', 'END'}
    
    filtered = [(w, c) for w, c in freq.items() if w not in common and len(w) > 2]
    filtered.sort(key=lambda x: -x[1])
    
    return [w for w, c in filtered[:max_keywords]]


def parse_pdf(filepath):
    if not PARSERS['pdf']:
        return None, {}
    try:
        reader = PdfReader(filepath)
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        return text, {'pages': len(reader.pages)}
    except:
        return None, {}


def parse_excel(filepath):
    if not PARSERS['excel']:
        return None, {}
    try:
        wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
        text = []
        for sheet_name in wb.sheetnames:
            sheet = wb[sheet_name]
            text.append(f'\n=== {sheet_name} ===')
            for row in sheet.iter_rows(values_only=True):
                row_text = '\t'.join(str(c) if c else '' for c in row)
                if row_text.strip():
                    text.append(row_text)
        wb.close()
        return '\n'.join(text), {'sheets': len(wb.sheetnames)}
    except:
        return None, {}


def parse_word(filepath):
    if not PARSERS['word']:
        return None, {}
    try:
        doc = Document(filepath)
        text = [p.text for p in doc.paragraphs if p.text.strip()]
        return '\n'.join(text), {'paragraphs': len(text)}
    except:
        return None, {}


def build_index(folders, output_path, verbose=False, skip_docs=False, docs_keywords_only=False):
    print("\n🔍 AstraCode Lightweight Index Builder\n")
    print("=" * 50)
    
    if skip_docs:
        print("\n⚠️  Skipping documents (--skip-docs)")
    elif docs_keywords_only:
        print("\n📄 Documents: keywords only (--docs-keywords-only)")
    
    print("\n📦 Document Parsers:")
    print(f"   PDF:   {'✅' if PARSERS['pdf'] else '❌ pip install pypdf2'}")
    print(f"   Excel: {'✅' if PARSERS['excel'] else '❌ pip install openpyxl'}")
    print(f"   Word:  {'✅' if PARSERS['word'] else '❌ pip install python-docx'}")
    
    index = {
        'version': '2.0',
        'type': 'lightweight',
        'created': datetime.now().isoformat(),
        'folders': [str(Path(f).absolute()) for f in folders],
        'files': {},
        'functions': [],
        'documents': {}
    }
    
    stats = {'code_files': 0, 'doc_files': 0, 'functions': 0, 'lines': 0, 'errors': 0}
    
    print(f"\n📁 Scanning {len(folders)} folder(s)...")
    
    all_files = []
    for folder in folders:
        folder = Path(folder)
        if not folder.exists():
            print(f"   ⚠️ Not found: {folder}")
            continue
        print(f"   - {folder}")
        
        for root, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fname in files:
                fpath = Path(root) / fname
                ext = fpath.suffix.lower()
                if ext in CODE_EXTENSIONS or ext in DOC_EXTENSIONS:
                    all_files.append((fpath, ext))
    
    print(f"\n⏳ Processing {len(all_files)} files...")
    
    for i, (fpath, ext) in enumerate(all_files):
        if verbose or (i + 1) % 100 == 0:
            print(f"   [{i+1}/{len(all_files)}]")
        
        fpath_str = str(fpath)
        
        try:
            if ext in DOC_EXTENSIONS:
                if skip_docs:
                    continue  # Skip all documents
                    
                doc_type = DOC_EXTENSIONS[ext]
                text, meta = None, {}
                
                if doc_type == 'pdf':
                    text, meta = parse_pdf(fpath)
                elif doc_type == 'excel':
                    text, meta = parse_excel(fpath)
                elif doc_type == 'word':
                    text, meta = parse_word(fpath)
                
                if text:
                    if docs_keywords_only:
                        # Keywords only - small footprint
                        index['documents'][fpath_str] = {
                            'path': fpath_str,
                            'name': fpath.name,
                            'type': doc_type,
                            'keywords': extract_keywords(text, 150),
                            'lines': len(text.split('\n'))
                        }
                    else:
                        # Full text - large but searchable
                        index['documents'][fpath_str] = {
                            'path': fpath_str,
                            'name': fpath.name,
                            'type': doc_type,
                            'text': text,
                            'keywords': extract_keywords(text, 100),
                            'lines': len(text.split('\n'))
                        }
                    stats['doc_files'] += 1
                    stats['lines'] += len(text.split('\n'))
            
            else:
                content = read_file(fpath)
                if content is None:
                    stats['errors'] += 1
                    continue
                
                lines = content.split('\n')
                functions = extract_functions(content, ext)
                keywords = extract_keywords(content, 50)
                
                index['files'][fpath_str] = {
                    'path': fpath_str,
                    'name': fpath.name,
                    'ext': ext,
                    'lines': len(lines),
                    'functions': functions,
                    'keywords': keywords
                }
                
                for func in functions:
                    index['functions'].append({
                        'name': func['name'],
                        'file': fpath_str,
                        'line': func['line']
                    })
                
                stats['code_files'] += 1
                stats['functions'] += len(functions)
                stats['lines'] += len(lines)
        
        except Exception as e:
            if verbose:
                print(f"      ❌ {e}")
            stats['errors'] += 1
    
    index['stats'] = stats
    
    print(f"\n💾 Saving to: {output_path}")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(index, f)
    
    size = os.path.getsize(output_path)
    size_str = f"{size/1024/1024:.1f}MB" if size > 1024*1024 else f"{size/1024:.0f}KB"
    
    print(f"\n✅ Done!")
    print(f"\n📊 Summary:")
    print(f"   Code files:  {stats['code_files']}")
    print(f"   Documents:   {stats['doc_files']}")
    print(f"   Functions:   {stats['functions']}")
    print(f"   Total lines: {stats['lines']:,}")
    print(f"   Index size:  {size_str}")


def main():
    parser = argparse.ArgumentParser(
        description='Build lightweight AstraCode index',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python astra-index.py ./my-project
    python astra-index.py ./src ./docs -o index.json
    python astra-index.py . --skip-docs            # Code only, smallest index
    python astra-index.py . --docs-keywords-only   # Docs searchable by keyword
        """
    )
    parser.add_argument('folders', nargs='+', help='Folders to index')
    parser.add_argument('-o', '--output', default='.astra-index.json', help='Output file')
    parser.add_argument('-v', '--verbose', action='store_true', help='Show details')
    parser.add_argument('--skip-docs', action='store_true', 
                        help='Skip PDF/Excel/Word files (smallest index)')
    parser.add_argument('--docs-keywords-only', action='store_true',
                        help='Store only keywords from documents (medium index)')
    args = parser.parse_args()
    
    build_index(args.folders, args.output, args.verbose, args.skip_docs, args.docs_keywords_only)


if __name__ == '__main__':
    main()
