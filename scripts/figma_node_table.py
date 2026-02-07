#!/usr/bin/env python3
"""
Converts nested Figma node JSON (from get_node_info_detailed) into a flat markdown table.

Usage:
    python figma_node_table.py --file node.json
    python figma_node_table.py < node.json
    echo '<json>' | python figma_node_table.py
"""

import json
import sys
import argparse


def compact_json(obj):
    """Convert an object to a compact JSON string, or '-' if empty/None."""
    if obj is None or obj == {} or obj == []:
        return "-"
    return json.dumps(obj, separators=(",", ":"))


def summarize_paints(paints):
    """Summarize a paints array compactly: 'SOLID #001c55; SOLID #ff0000 50%'"""
    if not paints:
        return "-"
    parts = []
    for p in paints:
        visible = p.get("visible", True)
        if visible is False:
            continue
        ptype = p.get("type", "?")
        color = p.get("color", "")
        opacity = p.get("opacity", 1)
        blend = p.get("blendMode", "NORMAL")
        s = ptype
        if color:
            s += " " + str(color)
        if opacity is not None and opacity != 1:
            s += " {0}%".format(int(round(opacity * 100)))
        if blend != "NORMAL":
            s += " " + blend
        stops = p.get("gradientStops", [])
        if stops:
            stop_parts = []
            for st in stops:
                sc = st.get("color", "")
                sp = st.get("position", "")
                stop_parts.append("{0}@{1}".format(sc, sp))
            s += " [" + ",".join(stop_parts) + "]"
        parts.append(s)
    return "; ".join(parts) if parts else "-"


def extract_bound_vars_summary(bound_vars):
    """Summarize boundVariables as 'key=varId; key=varId; ...'"""
    if not bound_vars:
        return "-"
    parts = []
    for key, val in bound_vars.items():
        if isinstance(val, dict) and "id" in val:
            parts.append("{0}={1}".format(key, val["id"]))
        elif isinstance(val, list):
            for i, item in enumerate(val):
                if isinstance(item, dict):
                    for subkey, subval in item.items():
                        if isinstance(subval, dict) and "id" in subval:
                            parts.append("{0}[{1}].{2}={3}".format(key, i, subkey, subval["id"]))
        else:
            parts.append("{0}={1}".format(key, val))
    return "; ".join(parts) if parts else "-"


def extract_effects_summary(effects):
    """Summarize effects array as 'type(radius, offset, color); ...'"""
    if not effects:
        return "-"
    parts = []
    for eff in effects:
        etype = eff.get("type", "?")
        radius = eff.get("radius", "")
        offset = eff.get("offset", {})
        ox = offset.get("x", 0) if offset else 0
        oy = offset.get("y", 0) if offset else 0
        color = eff.get("color", {})
        if color and isinstance(color, dict) and "r" in color:
            r = int(round(color.get("r", 0) * 255))
            g = int(round(color.get("g", 0) * 255))
            b = int(round(color.get("b", 0) * 255))
            a = color.get("a", 1)
            cstr = "#{:02x}{:02x}{:02x}".format(r, g, b)
            if a < 1:
                cstr += "{:02x}".format(int(round(a * 255)))
        elif isinstance(color, str):
            cstr = color
        else:
            cstr = ""
        parts.append("{0}(r={1},off={2},{3},c={4})".format(etype, radius, ox, oy, cstr))
    return "; ".join(parts) if parts else "-"


def extract_style_paints_summary(style_obj):
    """Extract compact paint summary from a style's properties.paints."""
    if not style_obj:
        return "-"
    props = style_obj.get("properties", {})
    if not props:
        return "-"
    paints = props.get("paints", [])
    return summarize_paints(paints)


def extract_text_style_summary(style_obj):
    """Extract compact text style properties summary."""
    if not style_obj:
        return "-"
    props = style_obj.get("properties", {})
    if not props:
        return "-"
    fn = props.get("fontName", {})
    parts = []
    if fn:
        parts.append("{0} {1}".format(fn.get("family", "?"), fn.get("style", "?")))
    parts.append("sz:{0}".format(props.get("fontSize", "?")))
    lh = props.get("lineHeight", {})
    if lh and isinstance(lh, dict):
        if lh.get("unit") == "AUTO":
            parts.append("lh:AUTO")
        else:
            parts.append("lh:{0}{1}".format(lh.get("value", "?"), "px" if lh.get("unit") == "PIXELS" else "%"))
    ls = props.get("letterSpacing", {})
    if ls and isinstance(ls, dict):
        parts.append("ls:{0}".format(ls.get("value", 0)))
    dec = props.get("textDecoration", "NONE")
    if dec != "NONE":
        parts.append("dec:{0}".format(dec))
    case = props.get("textCase", "ORIGINAL")
    if case != "ORIGINAL":
        parts.append("case:{0}".format(case))
    return " ".join(parts)


def flatten_node(node, parent_id="-", rows=None):
    if rows is None:
        rows = []

    node_id = node.get("id", "-")
    name = node.get("name", "-")
    node_type = node.get("type", "-")
    visible = node.get("visible", True)

    # Bounding box
    bbox = node.get("absoluteBoundingBox", {})
    x = bbox.get("x", "-")
    y = bbox.get("y", "-")
    w = bbox.get("width", "-")
    h = bbox.get("height", "-")

    # Fills / strokes — full summary
    fills = summarize_paints(node.get("fills", []))
    strokes = summarize_paints(node.get("strokes", []))

    radius = node.get("cornerRadius", "-")

    # Text content
    text = node.get("characters", "-")

    # Text style from node (resolved values)
    style = node.get("style", {})
    font_family = style.get("fontFamily", "-")
    font_style = style.get("fontStyle", "-")
    font_size = style.get("fontSize", "-")
    font_weight = style.get("fontWeight", "-")
    text_align = style.get("textAlignHorizontal", "-")
    letter_spacing = style.get("letterSpacing", "-")
    line_height = style.get("lineHeightPx", "-")

    # Applied styles
    styles = node.get("styles", {})

    fill_style_name = "-"
    fill_style_paints = "-"
    fs = styles.get("fillStyle")
    if fs:
        fill_style_name = fs.get("name", "-")
        fill_style_paints = extract_style_paints_summary(fs)

    stroke_style_name = "-"
    stroke_style_paints = "-"
    ss = styles.get("strokeStyle")
    if ss:
        stroke_style_name = ss.get("name", "-")
        stroke_style_paints = extract_style_paints_summary(ss)

    text_style_name = "-"
    text_style_props = "-"
    ts = styles.get("textStyle")
    if ts:
        text_style_name = ts.get("name", "-")
        text_style_props = extract_text_style_summary(ts)

    effect_style_name = "-"
    effect_style_effects = "-"
    es = styles.get("effectStyle")
    if es:
        effect_style_name = es.get("name", "-")
        props = es.get("properties", {})
        if props:
            effect_style_effects = extract_effects_summary(props.get("effects", []))

    # Bound variables
    bound_vars = extract_bound_vars_summary(node.get("boundVariables"))

    # Auto layout
    al = node.get("autoLayout")
    layout_mode = al.get("layoutMode", "-") if al else "-"
    layout_wrap = al.get("layoutWrap", "-") if al else "-"
    primary_align = al.get("primaryAxisAlignItems", "-") if al else "-"
    counter_align = al.get("counterAxisAlignItems", "-") if al else "-"
    counter_align_content = al.get("counterAxisAlignContent", "-") if al else "-"
    sizing_h = al.get("layoutSizingHorizontal", "-") if al else "-"
    sizing_v = al.get("layoutSizingVertical", "-") if al else "-"
    pad_top = al.get("paddingTop", "-") if al else "-"
    pad_right = al.get("paddingRight", "-") if al else "-"
    pad_bottom = al.get("paddingBottom", "-") if al else "-"
    pad_left = al.get("paddingLeft", "-") if al else "-"
    item_spacing = al.get("itemSpacing", "-") if al else "-"
    counter_spacing = al.get("counterAxisSpacing", "-") if al else "-"
    grid_rows = al.get("gridRowCount", "-") if al else "-"
    grid_cols = al.get("gridColumnCount", "-") if al else "-"
    grid_row_gap = al.get("gridRowGap", "-") if al else "-"
    grid_col_gap = al.get("gridColumnGap", "-") if al else "-"

    rows.append({
        "id": node_id,
        "parentId": parent_id,
        "name": name,
        "type": node_type,
        "visible": visible,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "fills": fills,
        "strokes": strokes,
        "radius": radius,
        "text": text,
        "fontFamily": font_family,
        "fontStyle": font_style,
        "fontSize": font_size,
        "fontWeight": font_weight,
        "textAlign": text_align,
        "letterSpacing": letter_spacing,
        "lineHeight": line_height,
        "layoutMode": layout_mode,
        "layoutWrap": layout_wrap,
        "primaryAlign": primary_align,
        "counterAlign": counter_align,
        "counterAlignContent": counter_align_content,
        "sizingH": sizing_h,
        "sizingV": sizing_v,
        "padTop": pad_top,
        "padRight": pad_right,
        "padBottom": pad_bottom,
        "padLeft": pad_left,
        "itemSpacing": item_spacing,
        "counterSpacing": counter_spacing,
        "gridRows": grid_rows,
        "gridCols": grid_cols,
        "gridRowGap": grid_row_gap,
        "gridColGap": grid_col_gap,
        "fillStyleName": fill_style_name,
        "fillStylePaints": fill_style_paints,
        "strokeStyleName": stroke_style_name,
        "strokeStylePaints": stroke_style_paints,
        "textStyleName": text_style_name,
        "textStyleProps": text_style_props,
        "effectStyleName": effect_style_name,
        "effectStyleEffects": effect_style_effects,
        "boundVars": bound_vars,
    })

    for child in node.get("children", []):
        flatten_node(child, parent_id=node_id, rows=rows)

    return rows


def format_cell(value):
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "yes" if value else "no"
    s = str(value)
    # Replace newlines with ↵ to keep table rows on one line
    s = s.replace("\r\n", " ↵ ").replace("\n", " ↵ ").replace("\r", " ↵ ")
    # Escape pipe characters for markdown tables
    s = s.replace("|", "\\|")
    return s


def to_markdown(rows):
    columns = [
        "id", "parentId", "name", "type", "visible",
        "x", "y", "w", "h",
        "fills", "strokes", "radius",
        "text", "fontFamily", "fontStyle", "fontSize", "fontWeight",
        "textAlign", "letterSpacing", "lineHeight",
        "layoutMode", "layoutWrap", "primaryAlign", "counterAlign", "counterAlignContent",
        "sizingH", "sizingV",
        "padTop", "padRight", "padBottom", "padLeft",
        "itemSpacing", "counterSpacing",
        "gridRows", "gridCols", "gridRowGap", "gridColGap",
        "fillStyleName", "fillStylePaints",
        "strokeStyleName", "strokeStylePaints",
        "textStyleName", "textStyleProps",
        "effectStyleName", "effectStyleEffects",
        "boundVars",
    ]

    header = "| " + " | ".join(columns) + " |"
    separator = "| " + " | ".join(["----"] * len(columns)) + " |"

    lines = [header, separator]
    for row in rows:
        cells = [format_cell(row.get(col, "-")) for col in columns]
        lines.append("| " + " | ".join(cells) + " |")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Flatten Figma node JSON to markdown table")
    parser.add_argument("--file", "-f", help="Path to JSON file (reads stdin if omitted)")
    args = parser.parse_args()

    if args.file:
        with open(args.file, "r") as f:
            data = json.load(f)
    else:
        data = json.load(sys.stdin)

    rows = flatten_node(data)
    md = to_markdown(rows)

    if args.file:
        out_path = args.file + ".md"
        with open(out_path, "w") as f:
            f.write(md + "\n")
        print("Written to: " + out_path)
    else:
        print(md)


if __name__ == "__main__":
    main()
