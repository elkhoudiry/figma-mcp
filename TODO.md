# Cursor Talk to Figma MCP - Development Roadmap

Last Updated: 2026-02-05

---

## ✅ Completed

- [x] Figma Variables Support
  - [x] `list_variables` - List all local variables
  - [x] `get_node_variables` - Get variable bindings for nodes
  - [x] `create_variable` - Create new variables
  - [x] `set_variable_value` - Set/update variable values
  - [x] `list_collections` - List variable collections
  - [x] `get_node_paints` - Get fills/strokes from nodes
  - [x] `set_node_paints` - Set fills/strokes with variable support

- [x] Paint Style Management
  - [x] `get_styles` - Get all styles (with multi-layer support)
  - [x] `create_paint_style` - Create color/paint styles
    - [x] Hardcoded colors support
    - [x] Variable-bound colors support
    - [x] Multi-layer paint support
    - [x] Gradients support
    - [x] Image fills support
    - [x] Per-layer opacity

---

## 🔥 Phase 1: Essential - Complete the Styles Workflow

**Priority: CRITICAL** - These complete the create → apply workflow

- [x] **`apply_paint_style`** ✅ **COMPLETED**
  - Apply existing paint styles to node fills or strokes
  - Parameters: `nodeId`, `styleId`, `property` ("fills" | "strokes")
  - Use case: Apply brand colors, bulk styling
  - Estimated complexity: Low

- [x] **`create_text_style`** ✅ **COMPLETED**
  - Create text styles with font properties
  - Parameters: `name`, `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, etc.
  - Support variable binding for font size, letter spacing
  - Use case: Design system typography
  - Estimated complexity: Medium

- [ ] **`apply_text_style`**
  - Apply existing text styles to text nodes
  - Parameters: `nodeId`, `styleId`
  - Use case: Apply typography consistently
  - Estimated complexity: Low

---

## 🔶 Phase 2: Very Useful - Style Inspection & Effects

**Priority: HIGH** - Adds critical design system capabilities

- [ ] **`get_node_styles`**
  - Get all styles currently applied to a node
  - Returns: `{ fillStyleId, strokeStyleId, textStyleId, effectStyleId }`
  - Use case: Audit styling, understand what's applied
  - Estimated complexity: Low

- [ ] **`create_effect_style`**
  - Create shadow and blur effect styles
  - Support: DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR
  - Parameters: `name`, `effects` array
  - Use case: Elevation system, consistent shadows
  - Estimated complexity: Medium

- [ ] **`apply_effect_style`**
  - Apply effect styles to nodes
  - Parameters: `nodeId`, `styleId`
  - Use case: Apply shadows/blurs
  - Estimated complexity: Low

---

## 🔷 Phase 3: Style Management

**Priority: MEDIUM** - Enables style editing and maintenance

- [ ] **`update_paint_style`**
  - Modify existing paint styles
  - Parameters: `styleId`, `paints`, `name`, `description`
  - Use case: Rebrand colors, update styles
  - Estimated complexity: Medium

- [ ] **`update_text_style`**
  - Modify existing text styles
  - Parameters: `styleId`, font properties
  - Use case: Update typography system
  - Estimated complexity: Medium

- [ ] **`update_effect_style`**
  - Modify existing effect styles
  - Parameters: `styleId`, `effects`
  - Use case: Adjust shadows/blurs
  - Estimated complexity: Medium

- [ ] **`delete_style`**
  - Remove styles from document
  - Parameters: `styleId`
  - Warning: Check for usage before deleting
  - Estimated complexity: Low

- [ ] **`detach_style`**
  - Remove style from node but keep properties
  - Parameters: `nodeId`, `styleType` ("fill" | "stroke" | "text" | "effect")
  - Use case: Make custom one-off changes
  - Estimated complexity: Low

---

## 💎 Phase 4: Advanced Features

**Priority: NICE TO HAVE** - Advanced workflows and automation

### Component & Instance Management

- [ ] **`create_component`**
  - Create reusable components from nodes
  - Parameters: `nodeId`, `name`, `description`
  - Use case: Build component libraries
  - Estimated complexity: Medium

- [ ] **`swap_component_instance`**
  - Change which component an instance points to
  - Parameters: `instanceId`, `newComponentKey`
  - Use case: Swap button variants, update instances
  - Estimated complexity: Low

- [ ] **`get_component_styles`**
  - Get all styles used in a component tree
  - Parameters: `componentId`
  - Returns: Array of style IDs and usage count
  - Use case: Audit component styling, extract tokens
  - Estimated complexity: Medium

### Style Utilities

- [ ] **`duplicate_style`**
  - Clone existing styles for variations
  - Parameters: `styleId`, `newName`
  - Use case: Create style variations (light/dark)
  - Estimated complexity: Low

- [ ] **`find_nodes_with_style`**
  - Find all nodes using a specific style
  - Parameters: `styleId`
  - Returns: Array of node IDs
  - Use case: Impact analysis before style changes
  - Estimated complexity: Medium

- [ ] **`batch_apply_styles`**
  - Apply multiple styles to multiple nodes at once
  - Parameters: `operations` array of `{ nodeId, styleId, styleType }`
  - Use case: Bulk styling operations
  - Estimated complexity: Medium

### Auto Layout Enhancements

- [ ] **`set_auto_layout`**
  - Comprehensive auto-layout configuration
  - Parameters: `nodeId`, `mode`, `padding`, `spacing`, alignment options
  - Use case: Create responsive components
  - Estimated complexity: High
  - Note: Some basic auto-layout tools already exist (set_padding, set_layout_mode, etc.)

- [ ] **`set_constraints`**
  - Set layout constraints for nodes
  - Parameters: `nodeId`, `horizontal`, `vertical`
  - Use case: Responsive design
  - Estimated complexity: Low

---

## 🎨 Phase 5: Design Token Management

**Priority: FUTURE** - Advanced design systems features

- [ ] **`export_design_tokens`**
  - Export variables and styles as design tokens JSON
  - Format: Style Dictionary compatible
  - Use case: Code generation, design-dev handoff
  - Estimated complexity: High

- [ ] **`import_design_tokens`**
  - Import design tokens and create variables/styles
  - Parameters: `tokens` JSON object
  - Use case: Sync from code to design
  - Estimated complexity: High

- [ ] **`sync_variable_to_style`**
  - Automatically create/update styles from variables
  - Parameters: `variableId` or collection
  - Use case: Maintain variable-style consistency
  - Estimated complexity: Medium

---

## 📊 Progress Summary

**Total Tasks:** 30
**Completed:** 10 (33%)
**Phase 1 (Critical):** 2/3 (67%)
**Phase 2 (High):** 0/3 (0%)
**Phase 3 (Medium):** 0/5 (0%)
**Phase 4 (Nice to Have):** 0/9 (0%)
**Phase 5 (Future):** 0/3 (0%)

---

## 🚀 Immediate Next Steps

1. ~~**`apply_paint_style`**~~ ✅ **COMPLETED**
2. ~~**`create_text_style`**~~ ✅ **COMPLETED**
3. **`apply_text_style`** - Enable typography workflows (NEXT)

---

## 📝 Notes

- All style tools should support both local and team library styles
- Consider adding batch operations for performance
- Effect styles should support multiple effects (like paint layers)
- Consider adding style validation before applying
- Add error handling for missing styles/nodes
- Document which Figma API versions are required

---

## 🐛 Known Issues & Improvements

- [ ] Fix optional chaining in older Figma plugin environment (if more found)
- [ ] Add better error messages for style operations
- [ ] Add progress reporting for batch operations
- [ ] Consider adding style preview/thumbnail generation
- [ ] Add style usage analytics (which styles are most used)

---

Last updated: 2026-02-05
Generated with Claude Code 🎨
