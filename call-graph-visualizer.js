/**
 * AstraCode Call Graph Visualizer v1.0
 * 
 * Generates an interactive HTML visualization of the call graph
 * that can be opened in a browser.
 * 
 * Features:
 * - Interactive D3.js force-directed graph
 * - Node coloring by file/module
 * - Click to highlight connections
 * - Search/filter functionality
 * - Zoom and pan
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pathUtils = require('./pathUtils');

/**
 * Generate call graph visualization HTML
 * 
 * @param {Object} options
 * @param {Map} options.callGraph - Map of caller -> Set of callees
 * @param {Map} options.reverseCallGraph - Map of callee -> Set of callers
 * @param {Map} options.symbols - Map of symbol name -> symbol info
 * @param {string} options.title - Title for the visualization
 * @returns {string} HTML content
 */
function generateCallGraphHTML(options = {}) {
    const {
        callGraph = new Map(),
        reverseCallGraph = new Map(),
        symbols = new Map(),
        title = 'AstraCode Call Graph'
    } = options;

    console.log(`[CallGraph HTML] Input: callGraph=${callGraph?.size || 0}, reverseCallGraph=${reverseCallGraph?.size || 0}, symbols=${symbols?.size || 0}`);

    // Build nodes and links for D3
    const nodes = [];
    const links = [];
    const nodeMap = new Map();
    const fileColors = new Map();
    let colorIndex = 0;

    // Color palette for files
    const colors = [
        '#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0',
        '#00BCD4', '#FFEB3B', '#795548', '#607D8B', '#F44336',
        '#3F51B5', '#009688', '#FFC107', '#673AB7', '#8BC34A'
    ];

    // Collect all unique functions
    const allFunctions = new Set();
    
    if (callGraph && callGraph.size > 0) {
        for (const [caller, callees] of callGraph) {
            allFunctions.add(caller);
            if (callees) {
                for (const callee of callees) {
                    allFunctions.add(callee);
                }
            }
        }
    }
    
    console.log(`[CallGraph HTML] Found ${allFunctions.size} unique functions`);

    // Create nodes
    for (const funcName of allFunctions) {
        const symbol = symbols.get(funcName);
        const file = symbol?.file || 'unknown';
        const fileName = pathUtils.getFileName(file) || file;
        
        // Assign color by file
        if (!fileColors.has(fileName)) {
            fileColors.set(fileName, colors[colorIndex % colors.length]);
            colorIndex++;
        }

        const calleeCount = callGraph.get(funcName)?.size || 0;
        const callerCount = reverseCallGraph.get(funcName)?.size || 0;

        nodes.push({
            id: funcName,
            name: funcName,
            file: fileName,
            fullPath: file,
            line: symbol?.line || 0,
            type: symbol?.type || 'function',
            color: fileColors.get(fileName),
            callees: calleeCount,
            callers: callerCount,
            // Size based on connectivity
            size: Math.max(5, Math.min(20, 5 + calleeCount + callerCount))
        });
        
        nodeMap.set(funcName, nodes.length - 1);
    }

    // Create links
    for (const [caller, callees] of callGraph) {
        for (const callee of callees) {
            if (nodeMap.has(caller) && nodeMap.has(callee)) {
                links.push({
                    source: caller,
                    target: callee
                });
            }
        }
    }

    // Build file legend
    const fileLegend = Array.from(fileColors.entries())
        .map(([file, color]) => `<span class="legend-item"><span class="legend-color" style="background:${color}"></span>${file}</span>`)
        .join('');

    // Generate HTML
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1e1e1e;
            color: #d4d4d4;
            overflow: hidden;
        }
        #container {
            display: flex;
            height: 100vh;
        }
        #sidebar {
            width: 280px;
            background: #252526;
            padding: 16px;
            overflow-y: auto;
            border-right: 1px solid #3c3c3c;
        }
        #graph-container {
            flex: 1;
            position: relative;
        }
        svg {
            width: 100%;
            height: 100%;
        }
        h1 {
            font-size: 16px;
            margin-bottom: 16px;
            color: #569cd6;
        }
        h2 {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #808080;
            margin: 16px 0 8px;
        }
        .search-box {
            width: 100%;
            padding: 8px 12px;
            background: #3c3c3c;
            border: 1px solid #4c4c4c;
            border-radius: 4px;
            color: #d4d4d4;
            font-size: 13px;
            margin-bottom: 12px;
        }
        .search-box:focus {
            outline: none;
            border-color: #569cd6;
        }
        .stats {
            font-size: 12px;
            color: #808080;
            margin-bottom: 16px;
        }
        .stats span {
            display: block;
            margin: 4px 0;
        }
        .legend {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            font-size: 11px;
            gap: 4px;
        }
        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
        }
        #info-panel {
            margin-top: 16px;
            padding: 12px;
            background: #2d2d2d;
            border-radius: 4px;
            display: none;
        }
        #info-panel.show { display: block; }
        #info-panel h3 {
            font-size: 14px;
            color: #4ec9b0;
            margin-bottom: 8px;
            word-break: break-all;
        }
        #info-panel p {
            font-size: 12px;
            margin: 4px 0;
            color: #9cdcfe;
        }
        #info-panel .label {
            color: #808080;
        }
        .link {
            stroke: #4c4c4c;
            stroke-opacity: 0.6;
            fill: none;
        }
        .link.highlighted {
            stroke: #569cd6;
            stroke-opacity: 1;
            stroke-width: 2px;
        }
        .node circle {
            stroke: #fff;
            stroke-width: 1.5px;
            cursor: pointer;
        }
        .node text {
            font-size: 10px;
            fill: #d4d4d4;
            pointer-events: none;
        }
        .node.dimmed circle {
            opacity: 0.2;
        }
        .node.dimmed text {
            opacity: 0.2;
        }
        .node.highlighted circle {
            stroke: #fff;
            stroke-width: 3px;
        }
        .controls {
            position: absolute;
            top: 16px;
            right: 16px;
            display: flex;
            gap: 8px;
        }
        .controls button {
            padding: 8px 12px;
            background: #3c3c3c;
            border: 1px solid #4c4c4c;
            border-radius: 4px;
            color: #d4d4d4;
            cursor: pointer;
            font-size: 12px;
        }
        .controls button:hover {
            background: #4c4c4c;
        }
        .tooltip {
            position: absolute;
            padding: 8px 12px;
            background: #252526;
            border: 1px solid #4c4c4c;
            border-radius: 4px;
            font-size: 12px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
            z-index: 1000;
        }
        .tooltip.show { opacity: 1; }
    </style>
</head>
<body>
    <div id="container">
        <div id="sidebar">
            <h1>🔗 ${title}</h1>
            <input type="text" class="search-box" id="search" placeholder="Search functions...">
            <div class="stats">
                <span>📊 <strong>${nodes.length}</strong> functions</span>
                <span>🔗 <strong>${links.length}</strong> call relationships</span>
                <span>📁 <strong>${fileColors.size}</strong> files</span>
            </div>
            <h2>Files</h2>
            <div class="legend">${fileLegend}</div>
            <div id="info-panel">
                <h3 id="info-name"></h3>
                <p><span class="label">File:</span> <span id="info-file"></span></p>
                <p><span class="label">Line:</span> <span id="info-line"></span></p>
                <p><span class="label">Calls:</span> <span id="info-callees"></span> functions</p>
                <p><span class="label">Called by:</span> <span id="info-callers"></span> functions</p>
            </div>
        </div>
        <div id="graph-container">
            <div class="controls">
                <button onclick="resetZoom()">Reset View</button>
                <button onclick="toggleLabels()">Toggle Labels</button>
            </div>
            <svg id="graph"></svg>
            <div class="tooltip" id="tooltip"></div>
        </div>
    </div>

    <script>
        const nodes = ${JSON.stringify(nodes)};
        const links = ${JSON.stringify(links)};
        
        let showLabels = true;
        
        const svg = d3.select("#graph");
        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        svg.attr("viewBox", [0, 0, width, height]);
        
        // Create zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on("zoom", (event) => {
                g.attr("transform", event.transform);
            });
        
        svg.call(zoom);
        
        const g = svg.append("g");
        
        // Create arrow marker for directed edges
        svg.append("defs").append("marker")
            .attr("id", "arrowhead")
            .attr("viewBox", "-0 -5 10 10")
            .attr("refX", 20)
            .attr("refY", 0)
            .attr("orient", "auto")
            .attr("markerWidth", 6)
            .attr("markerHeight", 6)
            .append("path")
            .attr("d", "M 0,-5 L 10,0 L 0,5")
            .attr("fill", "#4c4c4c");
        
        // Create simulation
        const simulation = d3.forceSimulation(nodes)
            .force("link", d3.forceLink(links).id(d => d.id).distance(80))
            .force("charge", d3.forceManyBody().strength(-200))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("collision", d3.forceCollide().radius(d => d.size + 10));
        
        // Create links
        const link = g.append("g")
            .selectAll("line")
            .data(links)
            .join("line")
            .attr("class", "link")
            .attr("marker-end", "url(#arrowhead)");
        
        // Create nodes
        const node = g.append("g")
            .selectAll("g")
            .data(nodes)
            .join("g")
            .attr("class", "node")
            .call(d3.drag()
                .on("start", dragstarted)
                .on("drag", dragged)
                .on("end", dragended));
        
        node.append("circle")
            .attr("r", d => d.size)
            .attr("fill", d => d.color)
            .on("mouseover", showTooltip)
            .on("mouseout", hideTooltip)
            .on("click", selectNode);
        
        node.append("text")
            .attr("dx", d => d.size + 4)
            .attr("dy", 4)
            .text(d => d.name);
        
        // Simulation tick
        simulation.on("tick", () => {
            link
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);
            
            node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
        });
        
        // Drag functions
        function dragstarted(event) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
        }
        
        function dragged(event) {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
        }
        
        function dragended(event) {
            if (!event.active) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
        }
        
        // Tooltip
        const tooltip = document.getElementById('tooltip');
        
        function showTooltip(event, d) {
            tooltip.innerHTML = \`<strong>\${d.name}</strong><br>\${d.file}:\${d.line}\`;
            tooltip.style.left = (event.pageX + 10) + 'px';
            tooltip.style.top = (event.pageY - 10) + 'px';
            tooltip.classList.add('show');
        }
        
        function hideTooltip() {
            tooltip.classList.remove('show');
        }
        
        // Node selection
        let selectedNode = null;
        
        function selectNode(event, d) {
            event.stopPropagation();
            
            if (selectedNode === d) {
                // Deselect
                selectedNode = null;
                node.classed("dimmed", false).classed("highlighted", false);
                link.classed("highlighted", false);
                document.getElementById('info-panel').classList.remove('show');
                return;
            }
            
            selectedNode = d;
            
            // Get connected nodes
            const connected = new Set([d.id]);
            links.forEach(l => {
                if (l.source.id === d.id) connected.add(l.target.id);
                if (l.target.id === d.id) connected.add(l.source.id);
            });
            
            // Highlight
            node.classed("dimmed", n => !connected.has(n.id));
            node.classed("highlighted", n => n.id === d.id);
            link.classed("highlighted", l => l.source.id === d.id || l.target.id === d.id);
            
            // Update info panel
            document.getElementById('info-name').textContent = d.name;
            document.getElementById('info-file').textContent = d.fullPath;
            document.getElementById('info-line').textContent = d.line || 'N/A';
            document.getElementById('info-callees').textContent = d.callees;
            document.getElementById('info-callers').textContent = d.callers;
            document.getElementById('info-panel').classList.add('show');
        }
        
        // Click background to deselect
        svg.on("click", () => {
            if (selectedNode) {
                selectedNode = null;
                node.classed("dimmed", false).classed("highlighted", false);
                link.classed("highlighted", false);
                document.getElementById('info-panel').classList.remove('show');
            }
        });
        
        // Search
        document.getElementById('search').addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            if (!query) {
                node.classed("dimmed", false);
                return;
            }
            node.classed("dimmed", d => !d.name.toLowerCase().includes(query));
        });
        
        // Controls
        function resetZoom() {
            svg.transition().duration(750).call(
                zoom.transform,
                d3.zoomIdentity
            );
        }
        
        function toggleLabels() {
            showLabels = !showLabels;
            node.selectAll("text").style("display", showLabels ? "block" : "none");
        }
        
        // Initial zoom to fit
        setTimeout(() => {
            const bounds = g.node().getBBox();
            const fullWidth = width;
            const fullHeight = height;
            const midX = bounds.x + bounds.width / 2;
            const midY = bounds.y + bounds.height / 2;
            const scale = 0.8 / Math.max(bounds.width / fullWidth, bounds.height / fullHeight);
            const translate = [fullWidth / 2 - scale * midX, fullHeight / 2 - scale * midY];
            
            svg.transition().duration(750).call(
                zoom.transform,
                d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
            );
        }, 1000);
    </script>
</body>
</html>`;
}

/**
 * Save call graph HTML to temp file and return path
 */
function saveCallGraphToFile(html, filename = 'astracode-callgraph.html') {
    const tempDir = os.tmpdir();
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, html, 'utf8');
    return filePath;
}

/**
 * Generate and save call graph visualization
 * 
 * @param {Object} codebaseIndex - The CodebaseIndex instance
 * @param {Object} options - Options
 * @returns {string} Path to generated HTML file
 */
function generateCallGraphFile(codebaseIndex, options = {}) {
    const {
        title = 'AstraCode Call Graph',
        filename = 'astracode-callgraph.html'
    } = options;

    // Defensive: ensure we have valid data
    const callGraph = codebaseIndex.callGraph || new Map();
    const reverseCallGraph = codebaseIndex.reverseCallGraph || new Map();
    const symbols = codebaseIndex.symbols || new Map();
    
    console.log(`[CallGraph] Generating: ${callGraph.size} funcs, ${reverseCallGraph.size} reverse, ${symbols.size} symbols`);

    const html = generateCallGraphHTML({
        callGraph: callGraph,
        reverseCallGraph: reverseCallGraph,
        symbols: symbols,
        title
    });

    return saveCallGraphToFile(html, filename);
}

module.exports = {
    generateCallGraphHTML,
    saveCallGraphToFile,
    generateCallGraphFile
};
