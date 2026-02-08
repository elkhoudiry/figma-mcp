#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
}>();

// Track which channel each client is in
let currentChannel: string | null = null;

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find(arg => arg.startsWith('--server='));
const serverUrl = serverArg ? serverArg.split('=')[1] : 'localhost';
const WS_URL = serverUrl === 'localhost' ? `ws://${serverUrl}` : `wss://${serverUrl}`;

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Selection Tool
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Read My Design Tool
server.tool(
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("read_my_design", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Info Tool
server.tool(
  "get_node_info",
  "Get basic information about a node in Figma — returns filtered properties (id, name, type, fills as hex, strokes, cornerRadius, boundingBox, text characters, font style, children). Best for general-purpose reads during design creation and modification. Use get_node_info_detailed instead when auditing or reviewing.",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filterFigmaNode(result))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Detailed Node Info Tool
server.tool(
  "get_node_info_detailed",
  "Get comprehensive node data for auditing and design reviews. Returns basic info, applied styles (fill, stroke, text, effect), bound variables, and raw paints (unfiltered fills/strokes with boundVariables intact) — all in a single call. Use this when verifying correct style/variable usage or reviewing implementation accuracy. For general-purpose reads during creation, use get_node_info instead.",
  {
    nodeId: z.string().describe("The ID of the node to get detailed information about"),
  },
  async ({ nodeId }: { nodeId: string }) => {
    try {
      const result = await sendCommandToFigma("get_node_info_detailed", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting detailed node info: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

function rgbaToHex(color: any): string {
  // skip if color is already hex
  if (color.startsWith('#')) {
    return color;
  }

  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a === 255 ? '' : a.toString(16).padStart(2, '0')}`;
}

function filterFigmaNode(node: any) {
  // Skip VECTOR type nodes
  if (node.type === "VECTOR") {
    return null;
  }

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== undefined ? node.visible : true,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill: any) => {
      const processedFill = { ...fill };

      // Remove boundVariables and imageRef
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      // Process gradientStops if present
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop: any) => {
          const processedStop = { ...stop };
          // Convert color to hex if present
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          // Remove boundVariables
          delete processedStop.boundVariables;
          return processedStop;
        });
      }

      // Convert solid fill colors to hex
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke: any) => {
      const processedStroke = { ...stroke };
      // Remove boundVariables
      delete processedStroke.boundVariables;
      // Convert color to hex if present
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx
    };
  }

  if (node.children) {
    filtered.children = node.children
      .map((child: any) => filterFigmaNode(child))
      .filter((child: any) => child !== null); // Remove null children (VECTOR nodes)
  }

  return filtered;
}

// Nodes Info Tool
server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get information about")
  },
  async ({ nodeIds }: any) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId: any) => {
          const result = await sendCommandToFigma('get_node_info', { nodeId });
          return { nodeId, info: result };
        })
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results.map((result) => filterFigmaNode(result.info)))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);


// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma. Supports HORIZONTAL, VERTICAL, and GRID layout modes. For GRID: set gridRowCount/gridColumnCount to define the grid, gridRowGap/gridColumnGap for spacing, and gridRowSizes/gridColumnSizes for track sizing (FIXED, FLEX, HUG). After creating a GRID frame, use set_grid_child to position and align children within cells.",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional().describe("Auto-layout mode for the frame. GRID enables CSS Grid-style layout — set gridRowCount/gridColumnCount when using GRID."),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced. In HORIZONTAL layout: left/right. In VERTICAL layout: top/bottom."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame. In HORIZONTAL layout: top/bottom. In VERTICAL layout: left/right."),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    gridRowCount: z.number().int().min(1).optional().describe("Number of rows for GRID layout"),
    gridColumnCount: z.number().int().min(1).optional().describe("Number of columns for GRID layout"),
    gridRowGap: z.number().min(0).optional().describe("Gap between rows for GRID layout"),
    gridColumnGap: z.number().min(0).optional().describe("Gap between columns for GRID layout"),
    gridRowSizes: z.array(z.object({ type: z.enum(["FIXED", "FLEX", "HUG"]), value: z.number().optional() })).optional().describe("Row size definitions for GRID layout"),
    gridColumnSizes: z.array(z.object({ type: z.enum(["FIXED", "FLEX", "HUG"]), value: z.number().optional() })).optional().describe("Column size definitions for GRID layout")
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode,
    layoutWrap,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    primaryAxisAlignItems,
    counterAxisAlignItems,
    layoutSizingHorizontal,
    layoutSizingVertical,
    itemSpacing,
    gridRowCount,
    gridColumnCount,
    gridRowGap,
    gridColumnGap,
    gridRowSizes,
    gridColumnSizes
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
        layoutMode,
        layoutWrap,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        primaryAxisAlignItems,
        counterAxisAlignItems,
        layoutSizingHorizontal,
        layoutSizingVertical,
        itemSpacing,
        gridRowCount,
        gridColumnCount,
        gridRowGap,
        gridColumnGap,
        gridRowSizes,
        gridColumnSizes
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma (TextNode or FrameNode). Supports RGBA colors with alpha/transparency. All color values are 0-1 range.",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha/opacity component (0-1). 0=fully transparent, 1=fully opaque. Optional, defaults to 1."),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma. Supports RGBA colors with alpha/transparency. All color values are 0-1 range.",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha/opacity component (0-1). 0=fully transparent, 1=fully opaque. Optional, defaults to 1."),
    weight: z.number().positive().optional().describe("Stroke weight in pixels"),
    strokeWeightVariableId: z.string().optional().describe("Optional variable ID to bind the stroke weight to (FLOAT variable from list_variables)"),
  },
  async ({ nodeId, r, g, b, a, weight, strokeWeightVariableId }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
        strokeWeightVariableId,
      });
      const typedResult = result as { name: string };
      const bound = strokeWeightVariableId ? ` (weight bound to variable ${strokeWeightVariableId})` : "";
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}${bound}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Node Paints Tool
server.tool(
  "get_node_paints",
  "Retrieve the Paint[] definition (either fills or strokes) from a node in Figma. The returned array conforms to the Figma Plugin API Paint interface.",
  {
    nodeId: z.string().describe("The ID of the node whose paints to retrieve"),
    paintsType: z
      .enum(["fills", "strokes"])
      .optional()
      .default("fills")
      .describe("Which paint list to return. Defaults to 'fills'."),
  },
  async ({ nodeId, paintsType }) => {
    try {
      const result = await sendCommandToFigma("get_node_paints", {
        nodeId,
        paintsType,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node paints: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Set Node Paints Tool
server.tool(
  "set_node_paints",
  "Bind the fills or strokes of a node to a variable.",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    paints: z
    .array(
      z.object({
        type: z.enum([
          'SOLID',
          'GRADIENT_LINEAR',
          'GRADIENT_RADIAL',
          'GRADIENT_ANGULAR',
          'GRADIENT_DIAMOND',
          'IMAGE',
          'VIDEO',
          'VARIABLE_ALIAS',
        ]),
        visible: z.boolean().optional(),
        opacity: z.number().min(0).max(1).optional(),
        blendMode: z.string().optional(),
        boundVariables: z.object({
          color: z.object({
            type: z.string().optional(),
            variableId: z.string().describe("The ID of the variable to bind to the color in the format like VariableID:3:4"),
        }).describe("Optional bound variables for the paint").optional(),
      }).catchall(z.unknown())
  })
    .describe(
      "Array of Paint objects. Each object must conform to the Paint interface: type, opacity, color, gradientStops, scaleMode, imageHash, etc."
    )),
    paintsType: z
    .enum(["fills", "strokes"])
    .optional()
    .default("fills")
    .describe("Whether to apply the paints to 'fills' (default) or 'strokes'."),
  },
  async ({ nodeId, paints, paintsType }) => {
    try {
      const result = await sendCommandToFigma("set_node_paints", {
        nodeId,
        paints,
        paintsType: paintsType || "fills",
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated ${paintsType || "fills"} on node "${typedResult.name}".`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting node paints: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new position and/or reparent it under a different parent in Figma. When parentId is provided, the node is appended as the last child of the new parent. Position (x, y) is optional — if omitted, the node keeps its current coordinates.",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().optional().describe("New X position (optional if only reparenting)"),
    y: z.number().optional().describe("New Y position (optional if only reparenting)"),
    parentId: z.string().optional().describe("ID of the new parent node to move this node into (reparent). The node will be appended as the last child."),
  },
  async ({ nodeId, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y, parentId });
      const typedResult = result as { name: string; x: number; y: number; parentName?: string };
      const parts = [];
      if (parentId) parts.push(`reparented under "${typedResult.parentName}"`);
      if (x !== undefined && y !== undefined) parts.push(`positioned at (${typedResult.x}, ${typedResult.y})`);
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}": ${parts.join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y });
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma. Optionally bind width/height to Figma variables (FLOAT type). Cannot resize children of component instances — resize the instance itself or detach it first.",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
    widthVariableId: z.string().optional().describe("Optional variable ID to bind to width (must be a FLOAT variable)"),
    heightVariableId: z.string().optional().describe("Optional variable ID to bind to height (must be a FLOAT variable)"),
  },
  async ({ nodeId, width, height, widthVariableId, heightVariableId }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
        widthVariableId,
        heightVariableId,
      });
      const typedResult = result as { name: string };
      const bindings = [];
      if (widthVariableId) bindings.push(`width bound to variable ${widthVariableId}`);
      if (heightVariableId) bindings.push(`height bound to variable ${heightVariableId}`);
      const bindingText = bindings.length > 0 ? ` (${bindings.join(', ')})` : '';
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}${bindingText}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export a node as an image from Figma",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format"),
    scale: z.number().positive().optional().describe("Export scale"),
  },
  async ({ nodeId, format, scale }: any) => {
    try {
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };

      return {
        content: [
          {
            type: "image",
            data: typedResult.imageData,
            mimeType: typedResult.mimeType || "image/png",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Base64 Tool
server.tool(
  "export_node_as_base64",
  "Export a node from Figma as a base64-encoded string. Returns raw base64 text that can be decoded and saved to disk client-side (e.g. echo '<base64>' | base64 -d > file.png).",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format (default PNG)"),
    scale: z.number().positive().optional().describe("Export scale (default 1)"),
  },
  async ({ nodeId, format, scale }: any) => {
    try {
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };

      return {
        content: [
          {
            type: "text",
            text: typedResult.imageData,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as base64: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Text Content Tool
server.tool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Styles Tool
server.tool(
  "get_styles",
  "Get all styles from the current Figma document. Returns all paint layers for color styles, including multi-layer styles (paints array contains all layers from bottom to top).",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Paint Style Tool
server.tool(
  "create_paint_style",
  "Create a new paint/color style in Figma with single or multiple paint layers. IMPORTANT: Paint order matters! Paints are layered bottom-to-top: paints[0]=bottom layer (rendered first), paints[1]=middle, paints[n]=top layer. Supports solid colors (hardcoded or variable-bound), gradients, and image fills. Each layer can have its own opacity. Perfect for overlays, glassmorphism, or variable-based themes.",
  {
    name: z.string().describe("The name of the style (e.g., 'Primary Blue', 'Brand/Colors/Red')"),
    description: z.string().optional().describe("Optional description of the style"),
    paints: z.array(
      z.object({
        type: z.enum(['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE'])
          .describe("Type of paint. ORDERING MATTERS: Array index determines layer order (0=bottom, n=top)."),
        color: z.object({
          r: z.number().min(0).max(1).describe("Red component (0-1)"),
          g: z.number().min(0).max(1).describe("Green component (0-1)"),
          b: z.number().min(0).max(1).describe("Blue component (0-1)")
        }).optional().describe("Color for SOLID paints (use this OR boundVariables, not both)"),
        boundVariables: z.object({
          color: z.object({
            variableId: z.string().describe("ID of the color variable to bind (from list_variables)")
          }).optional().describe("Bind color to a Figma variable instead of hardcoding")
        }).optional().describe("Bind paint properties to variables instead of using hardcoded values"),
        opacity: z.number().min(0).max(1).optional().describe("Opacity (0-1), defaults to 1"),
        gradientStops: z.array(
          z.object({
            position: z.number().min(0).max(1).describe("Position along gradient (0-1)"),
            color: z.object({
              r: z.number().min(0).max(1),
              g: z.number().min(0).max(1),
              b: z.number().min(0).max(1),
              a: z.number().min(0).max(1).optional()
            })
          })
        ).optional().describe("Gradient stops (required for gradient types)"),
        gradientTransform: z.array(z.array(z.number())).optional()
          .describe("Gradient transform matrix (optional, defaults to identity)"),
        imageHash: z.string().optional().describe("Image hash (required for IMAGE type)"),
        scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']).optional()
          .describe("Image scale mode (for IMAGE type)")
      })
    ).min(1).describe("Array of paint layers in RENDER ORDER (at least one required). CRITICAL: paints[0]=BOTTOM layer (rendered first/behind), paints[n]=TOP layer (rendered last/in front). For overlays, put base color first, then overlay. For glassmorphism, stack from back to front. Order determines visibility!")
  },
  async ({ name, description, paints }) => {
    try {
      const result = await sendCommandToFigma("create_paint_style", {
        name,
        description,
        paints
      });
      const typedResult = result as { id: string; name: string; key: string };
      return {
        content: [
          {
            type: "text",
            text: `Created paint style "${typedResult.name}" with ID: ${typedResult.id} and key: ${typedResult.key}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating paint style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Apply Paint Style Tool
server.tool(
  "apply_paint_style",
  "Apply an existing paint style to a node's fills or strokes. Use this to quickly apply brand colors and maintain design system consistency.",
  {
    nodeId: z.string().describe("The ID of the node to apply the style to"),
    styleId: z.string().describe("The ID of the paint style to apply"),
    property: z.enum(["fills", "strokes"]).describe("Whether to apply the style to fills or strokes")
  },
  async ({ nodeId, styleId, property }) => {
    try {
      const result = await sendCommandToFigma("apply_paint_style", {
        nodeId,
        styleId,
        property
      });
      const typedResult = result as {
        success: boolean;
        nodeId: string;
        nodeName: string;
        styleId: string;
        styleName: string;
        property: string;
        message: string
      };
      return {
        content: [
          {
            type: "text",
            text: typedResult.message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying paint style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Create Text Style Tool
server.tool(
  "create_text_style",
  "Create a new text style in Figma with font properties. Supports font family, style, size, letter spacing, line height, paragraph spacing, text case, and text decoration. Perfect for building a typography system.",
  {
    name: z.string().describe("The name of the style (e.g., 'Heading/H1', 'Body/Regular')"),
    description: z.string().optional().describe("Optional description of the style"),
    fontFamily: z.string().describe("Font family name (e.g., 'Inter', 'Roboto', 'Arial')"),
    fontStyle: z.string().optional().describe("Font style — this controls font weight. Maps to Figma's fontName.style. Common values: 'Thin' (100), 'Extra Light' (200), 'Light' (300), 'Regular' (400), 'Medium' (500), 'Semi Bold' (600), 'Bold' (700), 'Extra Bold' (800), 'Black' (900). Some fonts also support 'Italic' variants like 'Bold Italic'. Defaults to 'Regular'."),
    fontSize: z.number().optional().describe("Font size in pixels (e.g., 16, 24, 32)"),
    letterSpacing: z.union([
      z.number(),
      z.object({
        value: z.number(),
        unit: z.enum(["PIXELS", "PERCENT"])
      })
    ]).optional().describe("Letter spacing - a number (pixels) or { value, unit } object"),
    lineHeight: z.union([
      z.number(),
      z.string(),
      z.object({
        value: z.number().optional(),
        unit: z.enum(["PIXELS", "PERCENT", "AUTO"])
      })
    ]).optional().describe("Line height - a number (pixels), 'auto', or { value, unit } object"),
    paragraphSpacing: z.number().optional().describe("Spacing between paragraphs in pixels"),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional().describe("Text case transformation"),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional().describe("Text decoration"),
    boundVariables: z.record(
      z.object({
        variableId: z.string().describe("The variable ID to bind")
      })
    ).optional().describe("Bind variables to text style properties. Keys are property names (e.g., 'fontFamily', 'fontStyle', 'fontSize', 'letterSpacing', 'lineHeight', 'paragraphSpacing'). Values contain the variableId to bind.")
  },
  async ({ name, description, fontFamily, fontStyle, fontSize, letterSpacing, lineHeight, paragraphSpacing, textCase, textDecoration, boundVariables }) => {
    try {
      const result = await sendCommandToFigma("create_text_style", {
        name,
        description,
        fontFamily,
        fontStyle,
        fontSize,
        letterSpacing,
        lineHeight,
        paragraphSpacing,
        textCase,
        textDecoration,
        boundVariables
      });
      const typedResult = result as { id: string; name: string; key: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text style "${typedResult.name}" with ID: ${typedResult.id} and key: ${typedResult.key}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Apply Text Style Tool
server.tool(
  "apply_text_style",
  "Apply an existing text style to a text node. Use this to apply typography styles consistently across text nodes.",
  {
    nodeId: z.string().describe("The ID of the text node to apply the style to"),
    styleId: z.string().describe("The ID of the text style to apply (from get_styles)")
  },
  async ({ nodeId, styleId }) => {
    try {
      const result = await sendCommandToFigma("apply_text_style", {
        nodeId,
        styleId
      });
      const typedResult = result as { message: string };
      return {
        content: [
          {
            type: "text",
            text: typedResult.message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying text style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Get Node Styles Tool
server.tool(
  "get_node_styles",
  "Get all styles currently applied to a node. Returns fill, stroke, text, and effect style IDs and names if applied.",
  {
    nodeId: z.string().describe("The ID of the node to inspect")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_node_styles", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node styles: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Create Effect Style Tool
server.tool(
  "create_effect_style",
  "Create shadow and blur effect styles in Figma. Supports DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, and BACKGROUND_BLUR. Multiple effects can be stacked. Each effect can bind color, radius, and spread to Figma variables for theme support. Perfect for elevation systems and consistent shadows.",
  {
    name: z.string().describe("The name of the style (e.g., 'Elevation/Level 1', 'Blur/Background')"),
    description: z.string().optional().describe("Optional description of the style"),
    effects: z.array(
      z.object({
        type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"])
          .describe("Type of effect"),
        color: z.object({
          r: z.number().min(0).max(1).describe("Red (0-1)"),
          g: z.number().min(0).max(1).describe("Green (0-1)"),
          b: z.number().min(0).max(1).describe("Blue (0-1)"),
          a: z.number().min(0).max(1).optional().describe("Alpha (0-1), defaults to 1")
        }).optional().describe("Shadow color (for DROP_SHADOW and INNER_SHADOW)"),
        offset: z.object({
          x: z.number().describe("X offset in pixels"),
          y: z.number().describe("Y offset in pixels")
        }).optional().describe("Shadow offset (for DROP_SHADOW and INNER_SHADOW)"),
        radius: z.number().min(0).describe("Blur radius in pixels"),
        spread: z.number().optional().describe("Shadow spread in pixels (for DROP_SHADOW and INNER_SHADOW)"),
        visible: z.boolean().optional().describe("Whether the effect is visible (defaults to true)"),
        blendMode: z.string().optional().describe("Blend mode (e.g., 'NORMAL', 'MULTIPLY')"),
        boundVariables: z.record(
          z.object({
            variableId: z.string().describe("The variable ID to bind")
          })
        ).optional().describe("Bind variables to effect properties. Keys: 'color' (COLOR var), 'radius' (FLOAT var), 'spread' (FLOAT var).")
      })
    ).min(1).describe("Array of effects to apply. Multiple effects are stacked."),
    boundVariables: z.record(
      z.object({
        variableId: z.string().describe("The variable ID to bind")
      })
    ).optional().describe("Bind variables to effect style properties.")
  },
  async ({ name, description, effects, boundVariables }) => {
    try {
      const result = await sendCommandToFigma("create_effect_style", {
        name,
        description,
        effects,
        boundVariables
      });
      const typedResult = result as { id: string; name: string; key: string };
      return {
        content: [
          {
            type: "text",
            text: `Created effect style "${typedResult.name}" with ID: ${typedResult.id} and key: ${typedResult.key}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating effect style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Apply Effect Style Tool
server.tool(
  "apply_effect_style",
  "Apply an existing effect style to a node. Use this to apply shadows, blurs, and other effects consistently.",
  {
    nodeId: z.string().describe("The ID of the node to apply the effect style to"),
    styleId: z.string().describe("The ID of the effect style to apply (from get_styles)")
  },
  async ({ nodeId, styleId }) => {
    try {
      const result = await sendCommandToFigma("apply_effect_style", {
        nodeId,
        styleId
      });
      const typedResult = result as { message: string };
      return {
        content: [
          {
            type: "text",
            text: typedResult.message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying effect style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Update Paint Style Tool
server.tool(
  "update_paint_style",
  "Modify an existing paint style. Can update name, description, and/or paints. Supports the same paint formats as create_paint_style including variable-bound colors, gradients, and image fills.",
  {
    styleId: z.string().describe("The ID of the paint style to update (from get_styles)"),
    name: z.string().optional().describe("New name for the style"),
    description: z.string().optional().describe("New description for the style"),
    paints: z.array(
      z.object({
        type: z.enum(['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE'])
          .describe("Type of paint"),
        color: z.object({
          r: z.number().min(0).max(1),
          g: z.number().min(0).max(1),
          b: z.number().min(0).max(1)
        }).optional().describe("Color for SOLID paints"),
        boundVariables: z.object({
          color: z.object({
            variableId: z.string()
          }).optional()
        }).optional().describe("Bind color to a variable"),
        opacity: z.number().min(0).max(1).optional().describe("Paint opacity (0-1)"),
        gradientStops: z.array(z.object({
          position: z.number().min(0).max(1),
          color: z.object({
            r: z.number().min(0).max(1),
            g: z.number().min(0).max(1),
            b: z.number().min(0).max(1),
            a: z.number().min(0).max(1).optional()
          })
        })).optional().describe("Gradient stops"),
        gradientTransform: z.array(z.array(z.number())).optional(),
        imageHash: z.string().optional(),
        scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']).optional()
      })
    ).optional().describe("New paints array (replaces existing paints)")
  },
  async ({ styleId, name, description, paints }) => {
    try {
      const result = await sendCommandToFigma("update_paint_style", { styleId, name, description, paints });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error updating paint style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Update Text Style Tool
server.tool(
  "update_text_style",
  "Modify an existing text style. Can update any combination of properties. Font weight is controlled via fontStyle parameter (e.g., 'Bold', 'Medium', 'Regular').",
  {
    styleId: z.string().describe("The ID of the text style to update (from get_styles)"),
    name: z.string().optional().describe("New name for the style"),
    description: z.string().optional().describe("New description for the style"),
    fontFamily: z.string().optional().describe("New font family"),
    fontStyle: z.string().optional().describe("Font style — controls weight. Values: 'Thin' (100), 'Extra Light' (200), 'Light' (300), 'Regular' (400), 'Medium' (500), 'Semi Bold' (600), 'Bold' (700), 'Extra Bold' (800), 'Black' (900)."),
    fontSize: z.number().optional().describe("New font size in pixels"),
    letterSpacing: z.union([
      z.number(),
      z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) })
    ]).optional().describe("Letter spacing"),
    lineHeight: z.union([
      z.number(),
      z.string(),
      z.object({ value: z.number().optional(), unit: z.enum(["PIXELS", "PERCENT", "AUTO"]) })
    ]).optional().describe("Line height"),
    paragraphSpacing: z.number().optional().describe("Paragraph spacing in pixels"),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    boundVariables: z.record(
      z.object({ variableId: z.string() })
    ).optional().describe("Bind variables to text style properties (fontSize, letterSpacing, lineHeight, paragraphSpacing)")
  },
  async ({ styleId, name, description, fontFamily, fontStyle, fontSize, letterSpacing, lineHeight, paragraphSpacing, textCase, textDecoration, boundVariables }) => {
    try {
      const result = await sendCommandToFigma("update_text_style", { styleId, name, description, fontFamily, fontStyle, fontSize, letterSpacing, lineHeight, paragraphSpacing, textCase, textDecoration, boundVariables });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error updating text style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Update Effect Style Tool
server.tool(
  "update_effect_style",
  "Modify an existing effect style. Can update name, description, and/or effects array. Supports DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR. Each effect can bind color, radius, and spread to Figma variables.",
  {
    styleId: z.string().describe("The ID of the effect style to update (from get_styles)"),
    name: z.string().optional().describe("New name for the style"),
    description: z.string().optional().describe("New description for the style"),
    effects: z.array(
      z.object({
        type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
        color: z.object({
          r: z.number().min(0).max(1),
          g: z.number().min(0).max(1),
          b: z.number().min(0).max(1),
          a: z.number().min(0).max(1).optional()
        }).optional(),
        offset: z.object({
          x: z.number(),
          y: z.number()
        }).optional(),
        radius: z.number().min(0),
        spread: z.number().optional(),
        visible: z.boolean().optional(),
        blendMode: z.string().optional(),
        boundVariables: z.record(
          z.object({
            variableId: z.string().describe("The variable ID to bind")
          })
        ).optional().describe("Bind variables to effect properties. Keys: 'color' (COLOR var), 'radius' (FLOAT var), 'spread' (FLOAT var).")
      })
    ).optional().describe("New effects array (replaces existing effects)"),
    boundVariables: z.record(
      z.object({ variableId: z.string() })
    ).optional().describe("Bind variables to effect style properties")
  },
  async ({ styleId, name, description, effects, boundVariables }) => {
    try {
      const result = await sendCommandToFigma("update_effect_style", { styleId, name, description, effects, boundVariables });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error updating effect style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Delete Style Tool
server.tool(
  "delete_style",
  "Remove a style from the document. Works with paint, text, effect, and grid styles. Warning: nodes using this style will lose the style binding.",
  {
    styleId: z.string().describe("The ID of the style to delete (from get_styles)")
  },
  async ({ styleId }) => {
    try {
      const result = await sendCommandToFigma("delete_style", { styleId });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error deleting style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Detach Style Tool
server.tool(
  "detach_style",
  "Remove a style binding from a node but keep the visual properties. The node retains its current appearance but is no longer linked to the style.",
  {
    nodeId: z.string().describe("The ID of the node to detach the style from"),
    styleType: z.enum(["fill", "stroke", "text", "effect"]).describe("Which style type to detach")
  },
  async ({ nodeId, styleType }) => {
    try {
      const result = await sendCommandToFigma("detach_style", { nodeId, styleType });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error detaching style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Component Tool
server.tool(
  "create_component",
  "Create a reusable component from an existing node. Converts the node into a component that can be instanced.",
  {
    nodeId: z.string().describe("The ID of the node to convert into a component"),
    name: z.string().optional().describe("Optional name for the component"),
    description: z.string().optional().describe("Optional description for the component")
  },
  async ({ nodeId, name, description }) => {
    try {
      const result = await sendCommandToFigma("create_component", { nodeId, name, description });
      const typedResult = result as { id: string; name: string; key: string; message: string };
      return { content: [{ type: "text", text: `${typedResult.message} (ID: ${typedResult.id}, key: ${typedResult.key})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error creating component: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Swap Component Instance Tool
server.tool(
  "swap_component_instance",
  "Change which component an instance points to. Swaps the underlying component while preserving overrides where possible.",
  {
    instanceId: z.string().describe("The ID of the component instance to modify"),
    newComponentKey: z.string().describe("The key of the new component to swap to (from get_local_components or get_team_components)")
  },
  async ({ instanceId, newComponentKey }) => {
    try {
      const result = await sendCommandToFigma("swap_component_instance", { instanceId, newComponentKey });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error swapping component: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Get Component Styles Tool
server.tool(
  "get_component_styles",
  "Get all styles used in a component tree. Walks all descendants and reports fill, stroke, text, and effect style usage with counts.",
  {
    componentId: z.string().describe("The ID of the component or node tree to audit")
  },
  async ({ componentId }) => {
    try {
      const result = await sendCommandToFigma("get_component_styles", { componentId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting component styles: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Duplicate Style Tool
server.tool(
  "duplicate_style",
  "Clone an existing style with a new name. Works with paint, text, and effect styles. Perfect for creating style variations (e.g., light/dark themes).",
  {
    styleId: z.string().describe("The ID of the style to duplicate (from get_styles)"),
    newName: z.string().describe("Name for the duplicated style")
  },
  async ({ styleId, newName }) => {
    try {
      const result = await sendCommandToFigma("duplicate_style", { styleId, newName });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error duplicating style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Find Nodes With Style Tool
server.tool(
  "find_nodes_with_style",
  "Find all nodes on the current page using a specific style. Returns node IDs, names, types, and which property uses the style. Use for impact analysis before style changes.",
  {
    styleId: z.string().describe("The ID of the style to search for")
  },
  async ({ styleId }) => {
    try {
      const result = await sendCommandToFigma("find_nodes_with_style", { styleId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error finding nodes: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Batch Apply Styles Tool
server.tool(
  "batch_apply_styles",
  "Apply multiple styles to multiple nodes in one operation. Each operation specifies a node, style, and style type. Reports success/failure for each operation.",
  {
    operations: z.array(
      z.object({
        nodeId: z.string().describe("The ID of the node"),
        styleId: z.string().describe("The ID of the style to apply"),
        styleType: z.enum(["fill", "stroke", "text", "effect"]).describe("Which property to apply the style to")
      })
    ).min(1).describe("Array of style operations to perform")
  },
  async ({ operations }) => {
    try {
      const result = await sendCommandToFigma("batch_apply_styles", { operations });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in batch apply: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Get Auto Layout Tool
server.tool(
  "get_auto_layout",
  "Get all auto-layout properties of a frame, component, or component set. Returns layout mode, padding, spacing, alignment, sizing, wrap, and grid properties (if GRID mode). Use this to read the current layout configuration before modifying it.",
  {
    nodeId: z.string().describe("The ID of the node to get auto-layout properties from"),
  },
  async ({ nodeId }: { nodeId: string }) => {
    try {
      const result = await sendCommandToFigma("get_auto_layout", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting auto-layout properties: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Auto Layout Tool
server.tool(
  "set_auto_layout",
  "Comprehensive auto-layout configuration in a single call. Sets layout mode, padding, spacing, alignment, sizing, and wrap. Only provided properties are changed. For alignment: combine primaryAxisAlignItems + counterAxisAlignItems to position children (e.g. top-left=MIN+MIN, center=CENTER+CENTER, bottom-right=MAX+MAX). In HORIZONTAL layout: primary=left/right, counter=top/bottom. In VERTICAL layout: primary=top/bottom, counter=left/right. For GRID mode, use gridRowCount/gridColumnCount and configure per-child alignment via set_grid_child.",
  {
    nodeId: z.string().describe("The ID of the frame to configure"),
    mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional().describe("Layout direction. GRID enables CSS Grid-style layout with rows/columns — set gridRowCount/gridColumnCount when using GRID."),
    padding: z.union([
      z.number().describe("Uniform padding on all sides"),
      z.object({
        top: z.number().optional(),
        right: z.number().optional(),
        bottom: z.number().optional(),
        left: z.number().optional()
      }).describe("Individual padding per side")
    ]).optional().describe("Padding - a number for uniform or object for individual sides"),
    itemSpacing: z.number().optional().describe("Distance between children. Ignored if primaryAxisAlignItems is SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns (only with WRAP)"),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment (MIN=left/top, MAX=right/bottom, CENTER=center, SPACE_BETWEEN=evenly spaced). In HORIZONTAL layout: left/right. In VERTICAL layout: top/bottom."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment (MIN=top/left, MAX=bottom/right, CENTER=center). In HORIZONTAL layout: top/bottom. In VERTICAL layout: left/right."),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether children wrap"),
    gridRowCount: z.number().int().min(1).optional().describe("Number of rows for GRID layout"),
    gridColumnCount: z.number().int().min(1).optional().describe("Number of columns for GRID layout"),
    gridRowGap: z.number().min(0).optional().describe("Gap between rows for GRID layout"),
    gridColumnGap: z.number().min(0).optional().describe("Gap between columns for GRID layout"),
    gridRowSizes: z.array(z.object({ type: z.enum(["FIXED", "FLEX", "HUG"]), value: z.number().optional() })).optional().describe("Row size definitions for GRID layout"),
    gridColumnSizes: z.array(z.object({ type: z.enum(["FIXED", "FLEX", "HUG"]), value: z.number().optional() })).optional().describe("Column size definitions for GRID layout"),
    boundVariables: z.object({
      paddingTop: z.string().optional().describe("Variable ID to bind to top padding"),
      paddingRight: z.string().optional().describe("Variable ID to bind to right padding"),
      paddingBottom: z.string().optional().describe("Variable ID to bind to bottom padding"),
      paddingLeft: z.string().optional().describe("Variable ID to bind to left padding"),
      itemSpacing: z.string().optional().describe("Variable ID to bind to item spacing"),
      counterAxisSpacing: z.string().optional().describe("Variable ID to bind to counter axis spacing"),
    }).optional().describe("Bind spacing/padding properties to Figma variables (FLOAT type). Keys are property names, values are variable IDs from list_variables.")
  },
  async ({ nodeId, mode, padding, itemSpacing, counterAxisSpacing, primaryAxisAlignItems, counterAxisAlignItems, layoutSizingHorizontal, layoutSizingVertical, layoutWrap, gridRowCount, gridColumnCount, gridRowGap, gridColumnGap, gridRowSizes, gridColumnSizes, boundVariables }: any) => {
    try {
      const result = await sendCommandToFigma("set_auto_layout", { nodeId, mode, padding, itemSpacing, counterAxisSpacing, primaryAxisAlignItems, counterAxisAlignItems, layoutSizingHorizontal, layoutSizingVertical, layoutWrap, gridRowCount, gridColumnCount, gridRowGap, gridColumnGap, gridRowSizes, gridColumnSizes, boundVariables });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting auto-layout: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Constraints Tool
server.tool(
  "set_constraints",
  "Set layout constraints for a node. Controls how a node behaves when its parent is resized.",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    horizontal: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional().describe("Horizontal constraint"),
    vertical: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional().describe("Vertical constraint")
  },
  async ({ nodeId, horizontal, vertical }) => {
    try {
      const result = await sendCommandToFigma("set_constraints", { nodeId, horizontal, vertical });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting constraints: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Grid Child Tool
server.tool(
  "set_grid_child",
  "Configure a child node within a GRID auto-layout frame. Set span, position, and alignment. Parent must have layoutMode GRID. Combine gridChildHorizontalAlign + gridChildVerticalAlign for positioning (e.g. top-left=MIN+MIN, center=CENTER+CENTER, bottom-right=MAX+MAX, stretch=AUTO+AUTO). Use gridRowSpan/gridColumnSpan to make a child span multiple rows or columns. Use rowIndex/columnIndex (0-based) to explicitly place a child in a specific cell.",
  {
    nodeId: z.string().describe("The ID of the child node to configure"),
    gridRowSpan: z.number().int().min(1).optional().describe("Number of rows this child spans"),
    gridColumnSpan: z.number().int().min(1).optional().describe("Number of columns this child spans"),
    rowIndex: z.number().int().min(0).optional().describe("Row index to position the child at (0-based)"),
    columnIndex: z.number().int().min(0).optional().describe("Column index to position the child at (0-based)"),
    gridChildHorizontalAlign: z.enum(["MIN", "MAX", "CENTER", "AUTO"]).optional().describe("Horizontal alignment of the child within its grid cell (MIN=left, MAX=right, CENTER=center, AUTO=stretch/fill width)"),
    gridChildVerticalAlign: z.enum(["MIN", "MAX", "CENTER", "AUTO"]).optional().describe("Vertical alignment of the child within its grid cell (MIN=top, MAX=bottom, CENTER=center, AUTO=stretch/fill height)")
  },
  async ({ nodeId, gridRowSpan, gridColumnSpan, rowIndex, columnIndex, gridChildHorizontalAlign, gridChildVerticalAlign }) => {
    try {
      const result = await sendCommandToFigma("set_grid_child", { nodeId, gridRowSpan, gridColumnSpan, rowIndex, columnIndex, gridChildHorizontalAlign, gridChildVerticalAlign });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting grid child: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Combine As Variants Tool
server.tool(
  "combine_as_variants",
  "Combine multiple components into a variant set (COMPONENT_SET). Each component becomes a variant. Components must exist first (use create_component). Returns the variant properties and their values.",
  {
    componentIds: z.array(z.string()).min(2).describe("Array of component IDs to combine (minimum 2)"),
    parentId: z.string().optional().describe("Optional parent node ID. Defaults to the first component's parent.")
  },
  async ({ componentIds, parentId }) => {
    try {
      const result = await sendCommandToFigma("combine_as_variants", { componentIds, parentId });
      const typedResult = result as { message: string; id: string; variantProperties: Record<string, string[]> };
      return { content: [{ type: "text", text: `${typedResult.message}\nID: ${typedResult.id}\nProperties: ${JSON.stringify(typedResult.variantProperties, null, 2)}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error combining variants: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Get Variant Properties Tool
server.tool(
  "get_variant_properties",
  "Get available variant properties and their possible values from a component set, variant component, or instance. Also returns current values if called on an instance, and lists all variant combinations.",
  {
    nodeId: z.string().describe("The ID of a COMPONENT_SET, a variant COMPONENT, or an INSTANCE of a variant")
  },
  async ({ nodeId }) => {
    try {
      const result = await sendCommandToFigma("get_variant_properties", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting variant properties: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Variant Properties Tool
server.tool(
  "set_variant_properties",
  "Switch variant on a component instance by setting property values. For example, set { \"State\": \"Hover\", \"Size\": \"Large\" } to switch to that variant combination.",
  {
    instanceId: z.string().describe("The ID of the component instance to modify"),
    properties: z.record(z.string()).describe("Object mapping property names to desired values (e.g., { \"State\": \"Hover\", \"Size\": \"Large\" })")
  },
  async ({ instanceId, properties }) => {
    try {
      const result = await sendCommandToFigma("set_variant_properties", { instanceId, properties });
      const typedResult = result as { message: string };
      return { content: [{ type: "text", text: typedResult.message }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting variant properties: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Get Team Components Tool
server.tool(
  "get_team_components",
  "Get all team components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_team_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting team components: ${error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma. Optionally place it inside a parent frame.",
  {
    componentKey: z.string().describe("Key of the component to instantiate"),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    parentId: z.string().optional().describe("Optional parent node ID to place the instance inside. If omitted, the instance is added to the current page root."),
  },
  async ({ componentKey, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentKey,
        x,
        y,
        parentId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Replace Node with Component Instance Tool
server.tool(
  "replace_with_instance",
  "Replace an existing node with a component instance in-place. Preserves position in parent auto-layout order. The original node is removed after replacement.",
  {
    nodeId: z.string().describe("The ID of the node to replace"),
    componentKey: z.string().describe("The key of the component to instantiate (from get_local_components or create_component)"),
  },
  async ({ nodeId, componentKey }: any) => {
    try {
      const result = await sendCommandToFigma("replace_with_instance", {
        nodeId,
        componentKey,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error replacing node with instance: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);


// Set Corner Radius Tool
server.tool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma. Optionally bind the radius to a Figma variable.",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      ),
    variableId: z
      .string()
      .optional()
      .describe(
        "Optional variable ID to bind the corner radius to (e.g. a FLOAT variable from list_variables). Binds all four corners, or only the corners specified by the corners array."
      ),
  },
  async ({ nodeId, radius, corners, variableId }: any) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
        variableId,
      });
      const typedResult = result as { name: string };
      const bound = variableId ? ` and bound to variable ${variableId}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px${bound}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Rename Node Tool
server.tool(
  "rename_node",
  "Rename a node in Figma. Changes the layer name visible in the layers panel.",
  {
    nodeId: z.string().describe("The ID of the node to rename"),
    name: z.string().describe("The new name for the node"),
  },
  async ({ nodeId, name }: any) => {
    try {
      const result = await sendCommandToFigma("rename_node", { nodeId, name });
      const typedResult = result as { oldName: string; newName: string };
      return {
        content: [
          {
            type: "text",
            text: `Renamed node from "${typedResult.oldName}" to "${typedResult.newName}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Visibility Tool
server.tool(
  "set_visibility",
  "Set the visibility of a node in Figma. Controls whether the node is visible or hidden in the canvas.",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    visible: z.boolean().describe("Whether the node should be visible (true) or hidden (false)"),
  },
  async ({ nodeId, visible }: any) => {
    try {
      const result = await sendCommandToFigma("set_visibility", { nodeId, visible });
      const typedResult = result as { name: string; visible: boolean };
      return {
        content: [
          {
            type: "text",
            text: `Set visibility of node "${typedResult.name}" to ${typedResult.visible ? "visible" : "hidden"}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting visibility: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Text Alignment Tool
server.tool(
  "set_text_align",
  "Set the text alignment of a text node in Figma. Controls horizontal and vertical text alignment.",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional().describe("Horizontal text alignment"),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional().describe("Vertical text alignment"),
  },
  async ({ nodeId, textAlignHorizontal, textAlignVertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_align", { nodeId, textAlignHorizontal, textAlignVertical });
      const typedResult = result as { name: string; textAlignHorizontal: string; textAlignVertical: string };
      return {
        content: [
          {
            type: "text",
            text: `Set text alignment of "${typedResult.name}" to horizontal: ${typedResult.textAlignHorizontal}, vertical: ${typedResult.textAlignVertical}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Create Node from SVG Tool
server.tool(
  "create_node_from_svg",
  "Create a node from an SVG string in Figma. The SVG content is parsed and rendered as a FrameNode containing vector children.",
  {
    svgContent: z.string().describe("The SVG content string to create a node from"),
    x: z.number().optional().describe("Optional X position (default 0)"),
    y: z.number().optional().describe("Optional Y position (default 0)"),
    name: z.string().optional().describe("Optional name for the created node"),
    parentId: z.string().optional().describe("Optional parent node ID to append the node to"),
  },
  async ({ svgContent, x, y, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_node_from_svg", {
        svgContent,
        x,
        y,
        name,
        parentId,
      });
      const typedResult = result as { id: string; name: string; x: number; y: number; width: number; height: number; parentId?: string };
      return {
        content: [
          {
            type: "text",
            text: `Created SVG node "${typedResult.name}" (ID: ${typedResult.id}) at (${typedResult.x}, ${typedResult.y}) with dimensions ${typedResult.width}x${typedResult.height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating node from SVG: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Create Image Tool
server.tool(
  "create_image",
  "Create an image node in Figma from base64-encoded image data (PNG, JPG, etc). Creates a rectangle filled with the image.",
  {
    imageData: z.string().describe("Base64-encoded image data (without data URI prefix)"),
    width: z.number().describe("Width of the image node"),
    height: z.number().describe("Height of the image node"),
    x: z.number().optional().describe("Optional X position (default 0)"),
    y: z.number().optional().describe("Optional Y position (default 0)"),
    name: z.string().optional().describe("Optional name for the image node (default 'Image')"),
    parentId: z.string().optional().describe("Optional parent node ID to append the image to"),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Image scale mode (default 'FILL')"),
  },
  async ({ imageData, width, height, x, y, name, parentId, scaleMode }: any) => {
    try {
      const result = await sendCommandToFigma("create_image", {
        imageData,
        width,
        height,
        x,
        y,
        name,
        parentId,
        scaleMode,
      });
      const typedResult = result as { id: string; name: string; x: number; y: number; width: number; height: number; imageHash: string; parentId?: string };
      return {
        content: [
          {
            type: "text",
            text: `Created image "${typedResult.name}" (ID: ${typedResult.id}) at (${typedResult.x}, ${typedResult.y}) with dimensions ${typedResult.width}x${typedResult.height}, imageHash: ${typedResult.imageHash}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating image: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Define design strategy prompt
server.prompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
    };
  }
);

server.prompt(
  "read_design_strategy",
  "Best practices for reading Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_my_design() to understand the current selection
   - If no selection ask user to select single or multiple nodes
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Node Scanning Tool
server.tool(
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
  },
  async ({ nodeId }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: "Starting text node scanning. This may take a moment for large designs...",
      };

      // Use the plugin's scan_text_nodes function with chunking flag
      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,  // Enable chunking on the plugin side
        chunkSize: 10       // Process 10 nodes at a time
      });

      // If the result indicates chunking was used, format the response accordingly
      if (result && typeof result === 'object' && 'chunks' in result) {
        const typedResult = result as {
          success: boolean,
          totalNodes: number,
          processedNodes: number,
          chunks: number,
          textNodes: Array<any>
        };

        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.textNodes, null, 2)
            }
          ],
        };
      }

      // If chunking wasn't used or wasn't reported in the result format, return the result as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for child nodes with specific types in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z.array(z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
  },
  async ({ nodeId, types }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(', ')}...`,
      };

      // Use the plugin's scan_nodes_by_types function
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types
      });

      // Format the response
      if (result && typeof result === 'object' && 'matchingNodes' in result) {
        const typedResult = result as {
          success: boolean,
          count: number,
          matchingNodes: Array<{
            id: string,
            name: string,
            type: string,
            bbox: {
              x: number,
              y: number,
              width: number,
              height: number
            }
          }>,
          searchedTypes: Array<string>
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(', ')}`;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.matchingNodes, null, 2)
            }
          ],
        };
      }

      // If the result is in an unexpected format, return it as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Text Replacement Strategy Prompt
server.prompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id", 
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Set Multiple Text Contents Tool
server.tool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        })
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }: any) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = text.length;

      // Use the plugin's set_multiple_text_contents function with chunking
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      // Cast the result to a specific type to work with it safely
      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;

      // Format the results for display
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Annotation Conversion Strategy Prompt
server.prompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
server.prompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Always join the appropriate channel first with \`join_channel()\`
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// Set Layout Mode Tool
server.tool(
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma. Use GRID for CSS Grid-style layout with rows and columns — then configure grid dimensions with set_auto_layout and position children with set_grid_child.",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).describe("Layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_mode", {
        nodeId,
        layoutMode,
        layoutWrap: layoutWrap || "NO_WRAP"
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Padding Tool
server.tool(
  "set_padding",
  "Set padding values for an auto-layout frame in Figma. Optionally bind padding properties to Figma variables.",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    paddingTop: z.number().optional().describe("Top padding value"),
    paddingRight: z.number().optional().describe("Right padding value"),
    paddingBottom: z.number().optional().describe("Bottom padding value"),
    paddingLeft: z.number().optional().describe("Left padding value"),
    boundVariables: z.object({
      paddingTop: z.string().optional().describe("Variable ID to bind to top padding"),
      paddingRight: z.string().optional().describe("Variable ID to bind to right padding"),
      paddingBottom: z.string().optional().describe("Variable ID to bind to bottom padding"),
      paddingLeft: z.string().optional().describe("Variable ID to bind to left padding"),
    }).optional().describe("Bind padding properties to Figma variables (FLOAT type). Keys are property names, values are variable IDs from list_variables."),
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft, boundVariables }: any) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        boundVariables,
      });
      const typedResult = result as { name: string };

      // Create a message about which padding values were set
      const paddingMessages = [];
      if (paddingTop !== undefined) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== undefined) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== undefined) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== undefined) paddingMessages.push(`left: ${paddingLeft}`);

      const paddingText = paddingMessages.length > 0
        ? `padding (${paddingMessages.join(', ')})`
        : "padding";

      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Axis Align Tool
server.tool(
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "BASELINE"])
      .optional()
      .describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }: any) => {
    try {
      const result = await sendCommandToFigma("set_axis_align", {
        nodeId,
        primaryAxisAlignItems,
        counterAxisAlignItems
      });
      const typedResult = result as { name: string };

      // Create a message about which alignments were set
      const alignMessages = [];
      if (primaryAxisAlignItems !== undefined) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== undefined) alignMessages.push(`counter: ${counterAxisAlignItems}`);

      const alignText = alignMessages.length > 0
        ? `axis alignment (${alignMessages.join(', ')})`
        : "axis alignment";

      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Layout Sizing Tool
server.tool(
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma. Does NOT work on Text nodes — Figma does not support layout sizing on text. Wrap the text in a frame and apply FILL to the wrapper instead.",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_sizing", {
        nodeId,
        layoutSizingHorizontal,
        layoutSizingVertical
      });
      const typedResult = result as { name: string };

      // Create a message about which sizing modes were set
      const sizingMessages = [];
      if (layoutSizingHorizontal !== undefined) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== undefined) sizingMessages.push(`vertical: ${layoutSizingVertical}`);

      const sizingText = sizingMessages.length > 0
        ? `layout sizing (${sizingMessages.join(', ')})`
        : "layout sizing";

      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Item Spacing Tool
server.tool(
  "set_item_spacing",
  "Set distance between children in an auto-layout frame. Optionally bind spacing properties to Figma variables.",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    itemSpacing: z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP."),
    boundVariables: z.object({
      itemSpacing: z.string().optional().describe("Variable ID to bind to item spacing"),
      counterAxisSpacing: z.string().optional().describe("Variable ID to bind to counter axis spacing"),
    }).optional().describe("Bind spacing properties to Figma variables (FLOAT type). Keys are property names, values are variable IDs from list_variables.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing, boundVariables}: any) => {
    try {
      const params: any = { nodeId };
      if (itemSpacing !== undefined) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== undefined) params.counterAxisSpacing = counterAxisSpacing;
      if (boundVariables !== undefined) params.boundVariables = boundVariables;

      const result = await sendCommandToFigma("set_item_spacing", params);
      const typedResult = result as { name: string, itemSpacing?: number, counterAxisSpacing?: number };

      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== undefined) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== undefined) message += ` counterAxisSpacing=${counterAxisSpacing}`;

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("get_reactions", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          },
          {
            type: "text",
            text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
          }
        ],
        followUp: {
          type: "prompt",
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Connectors Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId
      });

      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided"
            }
          ]
        };
      }

      const result = await sendCommandToFigma("create_connections", {
        connections
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
server.prompt(
  "reaction_to_connector_strategy",
  "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_my_design\` on the relevant node(s) to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_my_design\` or by calling \`get_node_info\` if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);

// Figma Variables: List all variables
server.tool(
  "list_variables",
  "List all local variables in the current Figma document. Returns an array of variable objects, including their id, name, type, and values.",
  {},
  async (): Promise<any> => {
    try {
      const result = await sendCommandToFigma("list_variables");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing variables: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Figma Variables: Get variable bindings for a node
server.tool(
  "get_node_variables",
  "Get all variable bindings for a specific node. Returns an object mapping property types (e.g., 'fills', 'strokes', 'opacity', etc.) to variable binding info.",
  {
    nodeId: z.string().describe("The ID of the node to get variable bindings for")
  },
  async ({ nodeId }: { nodeId: string }): Promise<any> => {
    try {
      const result = await sendCommandToFigma("get_node_variables", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `These are the variables for the node: ${JSON.stringify(result, null, 2)}, you may use the 'list_variables' tool to find the name of the variables.`,
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node variables: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Figma Variables: Create a new variable
server.tool(
  "create_variable",
  "Create a new variable inside a collection. Returns the created variable object.",
  {
    name: z.string().describe("The name of the variable"),
    resolvedType: z.enum(["FLOAT", "STRING", "BOOLEAN", "COLOR"]).describe("The type of the variable"),
    description: z.string().optional().describe("Optional description for the variable"),
    collectionId: z.string().describe("Collection ID to create the variable in you may use the 'list_collections' tool to find the collection ID")
  },
  async ({ name, resolvedType, description, collectionId }) => {
    try {
      // Structure matches Figma plugin API: https://www.figma.com/plugin-docs/api/VariableCollection/
      const params: any = {
        name,
        resolvedType,
        description,
        collectionId
      };

      const result = await sendCommandToFigma("create_variable", params);
      return {
        content: [
          {
            type: "text",
            text: `The variable has been created ${JSON.stringify(result, null, 2)} now you must 'set_variable_value' to assign the proper value to the variable. The variable will not be usable until it has a value assigned to it.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating variable: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

server.tool(
  "set_variable_value",
  "Set the value of a variable in the Figma document. Returns the updated variable object.",
  {
    variableId: z.string().describe("The ID of the variable to update"),
    modeId: z.string().optional().describe("Optional mode ID for the variable, if applicable"),
    value: z.union([
      z.number(),
      z.string(),
      z.boolean(),
      z.object({
        r: z.number().optional(),
        g: z.number().optional(),
        b: z.number().optional(),
        a: z.number().optional()
      })
    ]).optional().describe("The value for the variable. Use a number for FLOAT, string for STRING, boolean for BOOLEAN, or {r,g,b,a} object for COLOR."),
    valueType: z.enum(["FLOAT", "STRING", "BOOLEAN", "COLOR"]).describe("The type of the value to set"),
    variableReferenceId: z.string().optional().describe("Optional reference to another variable")
  },
  async ({ variableId, modeId, value, valueType, variableReferenceId }) => {
    try {
      const formattedValue = valueType === "COLOR" && value && typeof value === "object"
        ? {
            r: (value as any).r || 0,
            g: (value as any).g || 0,
            b: (value as any).b || 0,
            a: (value as any).a || 1
          }
        : value;

      const result = await sendCommandToFigma("set_variable_value", {
        variableId,
        modeId,
        value: formattedValue,
        valueType,
        variableReferenceId
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting variable value: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

server.tool(
  "create_collection",
  "Create a new variable collection in the Figma document.",
  {
    name: z.string().describe("The name of the collection to create"),
  },
  async ({ name }) => {
    try {
      const result = await sendCommandToFigma("create_collection", { name });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating collection: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

server.tool(
  "list_collections",
  "List all variable collections in the Figma document. Returns an array of collection objects, including their id, name, and type.",

  {},
  async (): Promise<any> => {
    try {
      const result = await sendCommandToFigma("list_collections");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing collections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);



// Define command types and parameters
type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_node_info_detailed"
  | "get_nodes_info"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "create_paint_style"
  | "apply_paint_style"
  | "create_text_style"
  | "apply_text_style"
  | "get_node_styles"
  | "create_effect_style"
  | "apply_effect_style"
  | "update_paint_style"
  | "update_text_style"
  | "update_effect_style"
  | "delete_style"
  | "detach_style"
  | "create_component"
  | "swap_component_instance"
  | "get_component_styles"
  | "duplicate_style"
  | "find_nodes_with_style"
  | "batch_apply_styles"
  | "get_auto_layout"
  | "set_auto_layout"
  | "set_grid_child"
  | "set_constraints"
  | "combine_as_variants"
  | "get_variant_properties"
  | "set_variant_properties"
  | "get_local_components"
  | "get_team_components"
  | "create_component_instance"
  | "replace_with_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "join"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  | "list_variables"
  | "create_collection"
  | "list_collections"
  | "get_node_variables"
  | "get_node_paints"
  | "set_node_paints"
  | "create_variable"
  | "set_variable_value"
  | "rename_node"
  | "set_visibility"
  | "set_text_align"
  | "create_node_from_svg"
  | "create_image";

// Define the parameters for each command
type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string };
  get_node_info_detailed: { nodeId: string };
  get_nodes_info: { nodeIds: string[] };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
    layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
    gridRowCount?: number;
    gridColumnCount?: number;
    gridRowGap?: number;
    gridColumnGap?: number;
    gridRowSizes?: Array<{ type: "FIXED" | "FLEX" | "HUG"; value?: number }>;
    gridColumnSizes?: Array<{ type: "FIXED" | "FLEX" | "HUG"; value?: number }>;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  move_node: {
    nodeId: string;
    x?: number;
    y?: number;
    parentId?: string;
  };
  resize_node: {
    nodeId: string;
    width: number;
    height: number;
    widthVariableId?: string;
    heightVariableId?: string;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  create_paint_style: {
    name: string;
    description?: string;
    paints: Array<{
      type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE';
      color?: { r: number; g: number; b: number };
      boundVariables?: {
        color?: {
          variableId: string;
        };
      };
      opacity?: number;
      gradientStops?: Array<{
        position: number;
        color: { r: number; g: number; b: number; a?: number };
      }>;
      gradientTransform?: number[][];
      imageHash?: string;
      scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE';
    }>;
  };
  apply_paint_style: {
    nodeId: string;
    styleId: string;
    property: "fills" | "strokes";
  };
  create_text_style: {
    name: string;
    description?: string;
    fontFamily: string;
    fontStyle?: string;
    fontSize?: number;
    letterSpacing?: number | { value: number; unit: "PIXELS" | "PERCENT" };
    lineHeight?: number | string | { value?: number; unit: "PIXELS" | "PERCENT" | "AUTO" };
    paragraphSpacing?: number;
    textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE";
    textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
    boundVariables?: Record<string, { variableId: string }>;
  };
  apply_text_style: {
    nodeId: string;
    styleId: string;
  };
  get_node_styles: {
    nodeId: string;
  };
  create_effect_style: {
    name: string;
    description?: string;
    effects: Array<{
      type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
      color?: { r: number; g: number; b: number; a?: number };
      offset?: { x: number; y: number };
      radius: number;
      spread?: number;
      visible?: boolean;
      blendMode?: string;
    }>;
    boundVariables?: Record<string, { variableId: string }>;
  };
  apply_effect_style: {
    nodeId: string;
    styleId: string;
  };
  update_paint_style: {
    styleId: string;
    name?: string;
    description?: string;
    paints?: Array<{
      type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE';
      color?: { r: number; g: number; b: number };
      boundVariables?: { color?: { variableId: string } };
      opacity?: number;
      gradientStops?: Array<{ position: number; color: { r: number; g: number; b: number; a?: number } }>;
      gradientTransform?: number[][];
      imageHash?: string;
      scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE';
    }>;
  };
  update_text_style: {
    styleId: string;
    name?: string;
    description?: string;
    fontFamily?: string;
    fontStyle?: string;
    fontSize?: number;
    letterSpacing?: number | { value: number; unit: "PIXELS" | "PERCENT" };
    lineHeight?: number | string | { value?: number; unit: "PIXELS" | "PERCENT" | "AUTO" };
    paragraphSpacing?: number;
    textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE";
    textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
    boundVariables?: Record<string, { variableId: string }>;
  };
  update_effect_style: {
    styleId: string;
    name?: string;
    description?: string;
    effects?: Array<{
      type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
      color?: { r: number; g: number; b: number; a?: number };
      offset?: { x: number; y: number };
      radius: number;
      spread?: number;
      visible?: boolean;
      blendMode?: string;
    }>;
    boundVariables?: Record<string, { variableId: string }>;
  };
  delete_style: {
    styleId: string;
  };
  detach_style: {
    nodeId: string;
    styleType: "fill" | "stroke" | "text" | "effect";
  };
  create_component: {
    nodeId: string;
    name?: string;
    description?: string;
  };
  swap_component_instance: {
    instanceId: string;
    newComponentKey: string;
  };
  get_component_styles: {
    componentId: string;
  };
  duplicate_style: {
    styleId: string;
    newName: string;
  };
  find_nodes_with_style: {
    styleId: string;
  };
  batch_apply_styles: {
    operations: Array<{
      nodeId: string;
      styleId: string;
      styleType: "fill" | "stroke" | "text" | "effect";
    }>;
  };
  get_auto_layout: { nodeId: string };
  set_auto_layout: {
    nodeId: string;
    mode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
    padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
    itemSpacing?: number;
    counterAxisSpacing?: number;
    primaryAxisAlignItems?: "MIN" | "MAX" | "CENTER" | "SPACE_BETWEEN";
    counterAxisAlignItems?: "MIN" | "MAX" | "CENTER" | "BASELINE";
    layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
    layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
    layoutWrap?: "NO_WRAP" | "WRAP";
    gridRowCount?: number;
    gridColumnCount?: number;
    gridRowGap?: number;
    gridColumnGap?: number;
    gridRowSizes?: Array<{ type: "FIXED" | "FLEX" | "HUG"; value?: number }>;
    gridColumnSizes?: Array<{ type: "FIXED" | "FLEX" | "HUG"; value?: number }>;
    boundVariables?: {
      paddingTop?: string;
      paddingRight?: string;
      paddingBottom?: string;
      paddingLeft?: string;
      itemSpacing?: string;
      counterAxisSpacing?: string;
    };
  };
  set_grid_child: {
    nodeId: string;
    gridRowSpan?: number;
    gridColumnSpan?: number;
    rowIndex?: number;
    columnIndex?: number;
    gridChildHorizontalAlign?: "MIN" | "MAX" | "CENTER" | "AUTO";
    gridChildVerticalAlign?: "MIN" | "MAX" | "CENTER" | "AUTO";
  };
  set_constraints: {
    nodeId: string;
    horizontal?: "MIN" | "MAX" | "CENTER" | "STRETCH" | "SCALE";
    vertical?: "MIN" | "MAX" | "CENTER" | "STRETCH" | "SCALE";
  };
  combine_as_variants: {
    componentIds: string[];
    parentId?: string;
  };
  get_variant_properties: {
    nodeId: string;
  };
  set_variant_properties: {
    instanceId: string;
    properties: Record<string, string>;
  };
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
    parentId?: string;
  };
  replace_with_instance: {
    nodeId: string;
    componentKey: string;
  };
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number;
  };
  execute_code: {
    code: string;
  };
  join: {
    channel: string;
  };
  set_corner_radius: {
    nodeId: string;
    radius: number;
    corners?: boolean[];
    variableId?: string;
  };
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  set_text_content: {
    nodeId: string;
    text: string;
  };
  scan_text_nodes: {
    nodeId: string;
    useChunking: boolean;
    chunkSize: number;
  };
  set_multiple_text_contents: {
    nodeId: string;
    text: Array<{ nodeId: string; text: string }>;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
  scan_nodes_by_types: {
    nodeId: string;
    types: Array<string>;
  };
  get_reactions: { nodeIds: string[] };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };
  list_variables: Record<string, never>;
  create_collection: { name: string };
  list_collections: Record<string, never>;
  get_node_variables: { nodeId: string };
  get_node_paints: { nodeId: string };
  set_node_paints: {
    nodeId: string;
    paints: Array<{
      type:
        | 'SOLID'
        | 'GRADIENT_LINEAR'
        | 'GRADIENT_RADIAL'
        | 'GRADIENT_ANGULAR'
        | 'GRADIENT_DIAMOND'
        | 'IMAGE'
        | 'VIDEO'
        | 'VARIABLE_ALIAS';
      visible?: boolean;
      opacity?: number;
      blendMode?: string;
      boundVariables?: {
        color?: {
          type: string;
          variableId: string;
        };
        [key: string]: unknown;
      };
      color?: { r: number; g: number; b: number; a?: number };
      gradientStops?: Array<{ color: { r: number; g: number; b: number; a?: number }; position: number }>;
      imageRef?: string;
      // Allow additional properties as per Paint interface
      [key: string]: unknown;
    }>;
    paintsType?: "fills" | "strokes";
  };
  create_variable: {
    name: string;
    resolvedType: "FLOAT" | "STRING" | "BOOLEAN" | "COLOR";
    scopes: string[];
    description?: string;
  };
  set_variable_value: {
    variableId: string;
    modeId?: string;
    collectionId?: string;
    valueType: "FLOAT" | "STRING" | "BOOLEAN" | "COLOR";
    value?: any; // Value can be of any type depending on the variable type
    variableReferenceId?: string; // Optional reference to another variable
  };
  rename_node: {
    nodeId: string;
    name: string;
  };
  set_visibility: {
    nodeId: string;
    visible: boolean;
  };
  set_text_align: {
    nodeId: string;
    textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
    textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  };
  create_node_from_svg: {
    svgContent: string;
    x?: number;
    y?: number;
    name?: string;
    parentId?: string;
  };
  create_image: {
    imageData: string;
    width: number;
    height: number;
    x?: number;
    y?: number;
    name?: string;
    parentId?: string;
    scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
  };
};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

// Update the connectToFigma function
function connectToFigma(port: number = 3055) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  const wsUrl = serverUrl === 'localhost' ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    logger.info('Connected to Figma socket server');
    // Reset channel on new connection
    currentChannel = null;
  });

  ws.on("message", (data: any) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any; // Allow any other properties
      }

      const json = JSON.parse(data) as ProgressMessage;

      // Handle progress updates
      if (json.type === 'progress_update') {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || '';

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();

          // Reset the timeout to prevent timeouts during long-running operations
          clearTimeout(request.timeout);

          // Create a new timeout
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error('Request to Figma timed out'));
            }
          }, 60000); // 60 second timeout for inactivity

          // Log progress
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === 'completed' && progressData.progress === 100) {
            // Optionally resolve early with partial data
            // request.resolve(progressData.payload);
            // pendingRequests.delete(requestId);

            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log('myResponse' + JSON.stringify(myResponse));

      // Handle response to a request
      if (
        myResponse.id &&
        pendingRequests.has(myResponse.id) &&
        myResponse.result
      ) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }

        pendingRequests.delete(myResponse.id);
      } else {
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on('close', () => {
    logger.info('Disconnected from Figma socket server');
    ws = null;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    // Attempt to reconnect
    logger.info('Attempting to reconnect in 2 seconds...');
    setTimeout(() => connectToFigma(port), 2000);
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Function to send commands to Figma
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error('Request to Figma timed out'));
      }
    }, timeoutMs);

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

// Update the join_channel tool
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // If no channel provided, ask the user for input
        return {
          content: [
            {
              type: "text",
              text: "Please provide a channel name to join:",
            },
          ],
          followUp: {
            tool: "join_channel",
            description: "Join the specified channel",
          },
        };
      }

      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});



