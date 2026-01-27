#!/usr/bin/env python3
"""
PDF to Markdown Converter with Image Extraction

Usage:
    python pdf2md.py input.pdf                    # Output: input.md + input_images/
    python pdf2md.py input.pdf -o output.md       # Custom output name
    python pdf2md.py input.pdf --no-images        # Skip image extraction
    python pdf2md.py *.pdf                        # Batch convert
    python pdf2md.py docs/ -r                     # Recursive directory

Requirements:
    pip install pymupdf pillow
"""

import argparse
import fitz  # pymupdf
import os
import re
import sys
from pathlib import Path
from typing import Optional


def extract_images(page: fitz.Page, page_num: int, output_dir: Path) -> list[dict]:
    """Extract images from a PDF page."""
    images = []
    image_list = page.get_images(full=True)
    
    for img_index, img_info in enumerate(image_list):
        xref = img_info[0]
        
        try:
            base_image = page.parent.extract_image(xref)
            if not base_image:
                continue
                
            image_bytes = base_image["image"]
            image_ext = base_image["ext"]
            
            # Generate filename
            img_filename = f"page{page_num + 1}_img{img_index + 1}.{image_ext}"
            img_path = output_dir / img_filename
            
            # Save image
            with open(img_path, "wb") as f:
                f.write(image_bytes)
            
            images.append({
                "filename": img_filename,
                "path": str(img_path),
                "page": page_num + 1,
                "index": img_index + 1
            })
            
        except Exception as e:
            print(f"  Warning: Could not extract image {img_index + 1} on page {page_num + 1}: {e}", file=sys.stderr)
    
    return images


def clean_text(text: str) -> str:
    """Clean extracted text for markdown."""
    # Remove excessive whitespace but preserve paragraph breaks
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    # Fix common PDF extraction issues
    text = re.sub(r'(?<=[a-z])-\n(?=[a-z])', '', text)  # Fix hyphenation
    text = re.sub(r'(?<=[.!?])\n(?=[A-Z])', '\n\n', text)  # Add paragraph breaks after sentences
    
    return text.strip()


def detect_headings(text: str) -> str:
    """Try to detect and format headings."""
    lines = text.split('\n')
    result = []
    
    for i, line in enumerate(lines):
        stripped = line.strip()
        
        # Skip empty lines
        if not stripped:
            result.append(line)
            continue
        
        # Detect potential headings (short, possibly uppercase, no ending punctuation)
        is_short = len(stripped) < 80
        is_uppercase = stripped.isupper() and len(stripped) > 3
        no_end_punct = not stripped.endswith(('.', ',', ';', ':'))
        next_is_empty = i + 1 < len(lines) and not lines[i + 1].strip()
        prev_is_empty = i > 0 and not lines[i - 1].strip()
        
        if is_short and no_end_punct and (prev_is_empty or i == 0):
            if is_uppercase:
                # Major heading
                result.append(f"\n## {stripped.title()}\n")
            elif stripped[0].isupper() and len(stripped) < 50 and next_is_empty:
                # Minor heading
                result.append(f"\n### {stripped}\n")
            else:
                result.append(line)
        else:
            result.append(line)
    
    return '\n'.join(result)


def convert_pdf_to_markdown(
    pdf_path: Path,
    output_path: Optional[Path] = None,
    extract_images_flag: bool = True,
    detect_headings_flag: bool = True
) -> dict:
    """
    Convert a PDF file to Markdown.
    
    Returns:
        dict with keys: output_path, images_dir, image_count, page_count
    """
    pdf_path = Path(pdf_path)
    
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    
    # Determine output paths
    if output_path is None:
        output_path = pdf_path.with_suffix('.md')
    else:
        output_path = Path(output_path)
    
    images_dir = output_path.parent / f"{output_path.stem}_images"
    
    # Create images directory if extracting images
    if extract_images_flag:
        images_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Converting: {pdf_path}")
    
    # Open PDF
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    
    markdown_content = []
    all_images = []
    
    # Add title from filename
    title = pdf_path.stem.replace('_', ' ').replace('-', ' ').title()
    markdown_content.append(f"# {title}\n")
    markdown_content.append(f"*Converted from: {pdf_path.name}*\n")
    markdown_content.append("---\n")
    
    # Process each page
    for page_num in range(page_count):
        page = doc[page_num]
        
        # Extract text
        text = page.get_text("text")
        text = clean_text(text)
        
        if detect_headings_flag:
            text = detect_headings(text)
        
        # Add page marker for long documents
        if page_count > 5:
            markdown_content.append(f"\n<!-- Page {page_num + 1} -->\n")
        
        markdown_content.append(text)
        
        # Extract images
        if extract_images_flag:
            page_images = extract_images(page, page_num, images_dir)
            
            # Insert image references
            for img in page_images:
                rel_path = f"{images_dir.name}/{img['filename']}"
                markdown_content.append(f"\n![Image from page {img['page']}]({rel_path})\n")
            
            all_images.extend(page_images)
    
    doc.close()
    
    # Write markdown file
    final_content = '\n'.join(markdown_content)
    
    # Clean up excessive newlines
    final_content = re.sub(r'\n{4,}', '\n\n\n', final_content)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(final_content)
    
    # Remove empty images directory if no images
    if extract_images_flag and not all_images and images_dir.exists():
        try:
            images_dir.rmdir()
        except:
            pass
    
    print(f"  Output: {output_path}")
    if all_images:
        print(f"  Images: {len(all_images)} extracted to {images_dir}")
    
    return {
        "output_path": str(output_path),
        "images_dir": str(images_dir) if all_images else None,
        "image_count": len(all_images),
        "page_count": page_count
    }


def process_directory(
    dir_path: Path,
    recursive: bool = False,
    **kwargs
) -> list[dict]:
    """Process all PDFs in a directory."""
    results = []
    
    pattern = "**/*.pdf" if recursive else "*.pdf"
    pdf_files = list(dir_path.glob(pattern))
    
    if not pdf_files:
        print(f"No PDF files found in {dir_path}")
        return results
    
    print(f"Found {len(pdf_files)} PDF files\n")
    
    for pdf_path in sorted(pdf_files):
        try:
            result = convert_pdf_to_markdown(pdf_path, **kwargs)
            results.append(result)
        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
            results.append({"error": str(e), "file": str(pdf_path)})
        print()
    
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Convert PDF files to Markdown with image extraction",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s document.pdf                  Convert single PDF
  %(prog)s document.pdf -o output.md     Custom output name
  %(prog)s *.pdf                         Convert multiple PDFs
  %(prog)s docs/ -r                      Convert all PDFs in directory (recursive)
  %(prog)s spec.pdf --no-images          Skip image extraction
        """
    )
    
    parser.add_argument(
        "input",
        nargs="+",
        help="PDF file(s) or directory to convert"
    )
    
    parser.add_argument(
        "-o", "--output",
        help="Output markdown file (only for single file input)"
    )
    
    parser.add_argument(
        "--no-images",
        action="store_true",
        help="Skip image extraction"
    )
    
    parser.add_argument(
        "--no-headings",
        action="store_true",
        help="Skip automatic heading detection"
    )
    
    parser.add_argument(
        "-r", "--recursive",
        action="store_true",
        help="Process directories recursively"
    )
    
    args = parser.parse_args()
    
    kwargs = {
        "extract_images_flag": not args.no_images,
        "detect_headings_flag": not args.no_headings
    }
    
    results = []
    
    for input_path in args.input:
        path = Path(input_path)
        
        if path.is_dir():
            results.extend(process_directory(path, recursive=args.recursive, **kwargs))
        elif path.exists():
            output = Path(args.output) if args.output and len(args.input) == 1 else None
            try:
                result = convert_pdf_to_markdown(path, output_path=output, **kwargs)
                results.append(result)
            except Exception as e:
                print(f"Error: {e}", file=sys.stderr)
                results.append({"error": str(e), "file": str(path)})
        elif '*' in input_path:
            # Handle glob patterns
            import glob
            for matched_path in glob.glob(input_path):
                matched = Path(matched_path)
                if matched.suffix.lower() == '.pdf':
                    try:
                        result = convert_pdf_to_markdown(matched, **kwargs)
                        results.append(result)
                    except Exception as e:
                        print(f"Error: {e}", file=sys.stderr)
        else:
            print(f"Not found: {input_path}", file=sys.stderr)
    
    # Summary
    if len(results) > 1:
        success = sum(1 for r in results if "error" not in r)
        total_images = sum(r.get("image_count", 0) for r in results if "error" not in r)
        print(f"\n{'='*40}")
        print(f"Converted: {success}/{len(results)} files")
        if total_images:
            print(f"Total images extracted: {total_images}")


if __name__ == "__main__":
    main()
