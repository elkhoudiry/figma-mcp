#!/usr/bin/env python3
"""
Figma Design Audit Script
Detects structural, numeric, and consistency issues from Figma JSON exports.
All checks use keys, values, array lengths, and math — no name/semantic matching.

Usage:
    python figma_audit.py input.json
    python figma_audit.py input.json --output report.json
    python figma_audit.py input.json --json
"""

import json
import sys
import argparse
from collections import defaultdict
from typing import Optional

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURABLE THRESHOLDS — adjust these to tune sensitivity
# ═══════════════════════════════════════════════════════════════════════════════

# Minimum WCAG contrast ratio for text on background
MIN_CONTRAST_RATIO_AA = 4.5
MIN_CONTRAST_RATIO_AAA = 7.0

# Minimum touch target size in pixels (Material = 48, iOS HIG = 44)
MIN_TOUCH_TARGET_PX = 44

# Maximum nesting depth before flagging
MAX_NESTING_DEPTH = 10

# Sibling dimension tolerance — flag if siblings differ by more than this many px
SIBLING_DIMENSION_TOLERANCE_PX = 0

# Minimum fraction of siblings that must have a boundVariables key
# for a missing key on a node to be flagged (0.0–1.0)
BOUND_VARIABLE_COVERAGE_THRESHOLD = 0.5

# Minimum fraction of siblings that must have a styles key
# for a missing key on a node to be flagged (0.0–1.0)
STYLES_COVERAGE_THRESHOLD = 0.5

# Whether to flag asymmetric padding (top != bottom or left != right)
FLAG_ASYMMETRIC_PADDING = True

# Default page background colour assumed for contrast calculations (hex)
DEFAULT_BACKGROUND_HEX = "#ffffff"

# Minimum children a frame must have to be treated as an interactive target
INTERACTIVE_FRAME_MIN_CHILDREN = 1

# Minimum siblings required to run any sibling-comparison check
MIN_SIBLINGS_FOR_COMPARISON = 2


# ═══════════════════════════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════════════════════════

def node_path(node: dict, ancestors: list[dict]) -> str:
    parts = [n.get("name", "?") for n in ancestors] + [node.get("name", "?")]
    return " > ".join(parts)


def walk(node: dict, ancestors: list[dict] = None):
    """Depth-first yield of (node, ancestors_list, depth)."""
    if ancestors is None:
        ancestors = []
    yield node, ancestors, len(ancestors)
    for child in node.get("children", []):
        yield from walk(child, ancestors + [node])


def bbox(node: dict) -> Optional[dict]:
    return node.get("absoluteBoundingBox")


def hex_to_rgb(h: str) -> tuple:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if len(h) == 6 else (0, 0, 0)


def _linearise(v: float) -> float:
    v /= 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def relative_luminance(r: int, g: int, b: int) -> float:
    return 0.2126 * _linearise(r) + 0.7152 * _linearise(g) + 0.0722 * _linearise(b)


def contrast_ratio(hex1: str, hex2: str) -> float:
    l1 = relative_luminance(*hex_to_rgb(hex1))
    l2 = relative_luminance(*hex_to_rgb(hex2))
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def composite_fills(fills: list[dict], bg: str = DEFAULT_BACKGROUND_HEX) -> Optional[str]:
    """Alpha-composite stacked SOLID fills onto *bg*."""
    if not fills:
        return None
    r, g, b = (float(c) for c in hex_to_rgb(bg))
    for f in fills:
        if f.get("type") != "SOLID" or not f.get("color"):
            continue
        fr, fg, fb = hex_to_rgb(f["color"])
        a = f.get("opacity", 1.0)
        r = r * (1 - a) + fr * a
        g = g * (1 - a) + fg * a
        b = b * (1 - a) + fb * a
    return "#{:02x}{:02x}{:02x}".format(
        max(0, min(255, int(r))),
        max(0, min(255, int(g))),
        max(0, min(255, int(b))),
    )


def bv_keys(node: dict) -> set:
    """Return the set of meaningful keys inside *boundVariables*."""
    out = set()
    for k, v in node.get("boundVariables", {}).items():
        if isinstance(v, list) and len(v) > 0:
            out.add(k)
        elif isinstance(v, dict) and v.get("type"):
            out.add(k)
    return out


def majority(values: list):
    """Return the most-common value in *values*."""
    return max(set(values), key=values.count) if values else None


# ═══════════════════════════════════════════════════════════════════════════════
# ISSUE COLLECTOR
# ═══════════════════════════════════════════════════════════════════════════════

_ICONS = {"ERROR": "✖", "WARNING": "⚠", "INFO": "ℹ"}


class Issues:
    def __init__(self):
        self.items: list[dict] = []

    def add(self, category: str, severity: str, message: str,
            node_id: str = "", path: str = ""):
        self.items.append(dict(
            category=category, severity=severity, message=message,
            node_id=node_id, path=path,
        ))

    # ── reports ──────────────────────────────────────────────────────────

    def text_report(self) -> str:
        by_cat = defaultdict(list)
        for i in self.items:
            by_cat[i["category"]].append(i)

        sev_rank = {"error": 0, "warning": 1, "info": 2}
        totals = defaultdict(int)
        lines = [
            "=" * 90,
            "  FIGMA DESIGN AUDIT REPORT",
            "=" * 90,
        ]

        for cat in sorted(by_cat):
            grp = sorted(by_cat[cat], key=lambda x: sev_rank.get(x["severity"], 9))
            lines += ["", f"┌── {cat}  ({len(grp)} issue{'s' if len(grp) != 1 else ''}) ──"]
            for it in grp:
                sev = it["severity"].upper()
                totals[it["severity"]] += 1
                lines.append(f"│  {_ICONS.get(sev, '•')} [{sev}] {it['message']}")
                if it["path"]:
                    lines.append(f"│     ↳ {it['path']}")
                if it["node_id"]:
                    lines.append(f"│     node: {it['node_id']}")
            lines.append(f"└{'─' * 70}")

        lines += [
            "",
            "─" * 90,
            f"  TOTALS:  {totals['error']} errors  │  {totals['warning']} warnings  "
            f"│  {totals['info']} info  │  {len(self.items)} total",
            "─" * 90,
        ]
        return "\n".join(lines)

    def json_report(self) -> str:
        totals = defaultdict(int)
        for i in self.items:
            totals[i["severity"]] += 1
        return json.dumps(
            {"summary": dict(totals), "total": len(self.items), "issues": self.items},
            indent=2,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# INDIVIDUAL CHECKS
# ═══════════════════════════════════════════════════════════════════════════════

# 1 ── Sub-pixel positions ────────────────────────────────────────────────────

def check_subpixel(root, issues):
    """Non-integer x / y / width / height → blurry rendering on export."""
    for nd, anc, _ in walk(root):
        bb = bbox(nd)
        if not bb:
            continue
        for key in ("x", "y", "width", "height"):
            v = bb.get(key, 0)
            if v != int(v):
                issues.add("Sub-pixel Values", "warning",
                           f"{key} = {v} (non-integer)",
                           nd.get("id", ""), node_path(nd, anc))


# 2 ── Child overflow ─────────────────────────────────────────────────────────

def check_overflow(root, issues):
    """Child bounding-box exceeds parent bounding-box."""
    for nd, anc, _ in walk(root):
        pb = bbox(nd)
        if not pb:
            continue
        px, py, pw, ph = pb["x"], pb["y"], pb["width"], pb["height"]
        for ch in nd.get("children", []):
            cb = bbox(ch)
            if not cb:
                continue
            parts = []
            if cb["x"] < px:
                parts.append(f"left by {round(px - cb['x'], 2)}px")
            if cb["x"] + cb["width"] > px + pw:
                parts.append(f"right by {round(cb['x'] + cb['width'] - px - pw, 2)}px")
            if cb["y"] < py:
                parts.append(f"top by {round(py - cb['y'], 2)}px")
            if cb["y"] + cb["height"] > py + ph:
                parts.append(f"bottom by {round(cb['y'] + cb['height'] - py - ph, 2)}px")
            if parts:
                issues.add("Child Overflow", "error",
                           f"Overflows parent: {', '.join(parts)}",
                           ch.get("id", ""), node_path(ch, anc + [nd]))


# 3 ── Sibling dimension mismatch ─────────────────────────────────────────────

def check_sibling_dimensions(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        ws = [(c, bbox(c)["width"]) for c in kids if bbox(c)]
        hs = [(c, bbox(c)["height"]) for c in kids if bbox(c)]
        if len(ws) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        cw = majority([w for _, w in ws])
        ch_ = majority([h for _, h in hs])
        for c, w in ws:
            d = abs(w - cw)
            if d > SIBLING_DIMENSION_TOLERANCE_PX:
                issues.add("Sibling Dimension Mismatch", "warning",
                           f"Width {w} vs majority {cw} (Δ{round(d, 1)}px)",
                           c.get("id", ""), node_path(c, anc + [nd]))
        for c, h in hs:
            d = abs(h - ch_)
            if d > SIBLING_DIMENSION_TOLERANCE_PX:
                issues.add("Sibling Dimension Mismatch", "warning",
                           f"Height {h} vs majority {ch_} (Δ{round(d, 1)}px)",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 4 ── Auto Layout mismatches among siblings ──────────────────────────────────

def check_sibling_autolayout(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        al_kids = [(c, c["autoLayout"]) for c in kids if c.get("autoLayout")]
        if len(al_kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue

        # layoutMode
        modes = [(c, al["layoutMode"]) for c, al in al_kids]
        cm = majority([m for _, m in modes])
        for c, m in modes:
            if m != cm:
                issues.add("Auto Layout Mismatch", "error",
                           f"layoutMode='{m}' vs majority '{cm}'",
                           c.get("id", ""), node_path(c, anc + [nd]))

        # padding tuple
        def _pad(al):
            return (al.get("paddingTop", 0), al.get("paddingRight", 0),
                    al.get("paddingBottom", 0), al.get("paddingLeft", 0))
        pads = [(c, _pad(al)) for c, al in al_kids]
        cp = majority([p for _, p in pads])
        for c, p in pads:
            if p != cp:
                issues.add("Auto Layout Mismatch", "warning",
                           f"Padding {p} vs majority {cp}",
                           c.get("id", ""), node_path(c, anc + [nd]))

        # itemSpacing
        sps = [(c, al.get("itemSpacing", 0)) for c, al in al_kids]
        cs = majority([s for _, s in sps])
        for c, s in sps:
            if s != cs:
                issues.add("Auto Layout Mismatch", "warning",
                           f"itemSpacing={s} vs majority {cs}",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 5 ── boundVariables coverage gaps ───────────────────────────────────────────

def check_bound_variables(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        child_bvs = [(c, bv_keys(c)) for c in kids]
        key_counts = defaultdict(int)
        for _, ks in child_bvs:
            for k in ks:
                key_counts[k] += 1
        thresh = len(kids) * BOUND_VARIABLE_COVERAGE_THRESHOLD
        maj_keys = {k for k, n in key_counts.items() if n >= thresh}
        for c, ks in child_bvs:
            missing = maj_keys - ks
            if missing:
                issues.add("Missing Variable Bindings", "warning",
                           f"Missing boundVariables keys: {sorted(missing)}",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 6 ── styles coverage gaps ───────────────────────────────────────────────────

def check_styles(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        child_st = [(c, set(c.get("styles", {}).keys())) for c in kids]
        key_counts = defaultdict(int)
        for _, ks in child_st:
            for k in ks:
                key_counts[k] += 1
        thresh = len(kids) * STYLES_COVERAGE_THRESHOLD
        maj_keys = {k for k, n in key_counts.items() if n >= thresh}
        for c, ks in child_st:
            missing = maj_keys - ks
            if missing:
                issues.add("Missing Style References", "warning",
                           f"Missing styles keys: {sorted(missing)}",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 7 ── Sibling child-count mismatch ───────────────────────────────────────────

def check_child_counts(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        containers = [(c, len(c.get("children", [])))
                      for c in kids if "children" in c and len(c.get("children", [])) > 0]
        if len(containers) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        cc = majority([n for _, n in containers])
        for c, n in containers:
            if n != cc:
                issues.add("Sibling Child Count Mismatch", "warning",
                           f"Has {n} children vs majority {cc}",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 8 ── Sibling fill-colour mismatch ──────────────────────────────────────────

def check_fill_color_mismatch(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        max_fills = max((len(c.get("fills", [])) for c in kids), default=0)
        for idx in range(max_fills):
            entries = []
            for c in kids:
                fs = c.get("fills", [])
                if idx < len(fs) and fs[idx].get("type") == "SOLID" and fs[idx].get("color"):
                    entries.append((c, fs[idx]["color"], fs[idx].get("opacity", 1.0)))
            if len(entries) < MIN_SIBLINGS_FOR_COMPARISON:
                continue
            val_groups = defaultdict(list)
            for c, col, op in entries:
                val_groups[(col, op)].append(c)
            if len(val_groups) <= 1:
                continue
            top = max(val_groups, key=lambda k: len(val_groups[k]))
            for val, nodes in val_groups.items():
                if val != top and len(nodes) < len(entries) / 2:
                    for n in nodes:
                        issues.add("Sibling Fill Color Mismatch", "warning",
                                   f"fills[{idx}] color={val[0]} opacity={val[1]}"
                                   f" vs majority color={top[0]} opacity={top[1]}",
                                   n.get("id", ""), node_path(n, anc + [nd]))


# 9 ── Sibling fill-array-length mismatch ─────────────────────────────────────

def check_fill_count(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        fl = [(c, len(c.get("fills", []))) for c in kids if "fills" in c]
        if len(fl) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        cf = majority([n for _, n in fl])
        for c, n in fl:
            if n != cf:
                issues.add("Sibling Fill Count Mismatch", "info",
                           f"Has {n} fills vs majority {cf}",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 10 ── Stroke presence / absence mismatch ────────────────────────────────────

def check_stroke_mismatch(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        pairs = [(c, len(c.get("strokes", [])) > 0) for c in kids]
        yes = sum(1 for _, s in pairs if s)
        no = sum(1 for _, s in pairs if not s)
        if yes > 0 and no > 0:
            minority_val = yes < no
            for c, has in pairs:
                if has == minority_val:
                    state = "has strokes" if has else "lacks strokes"
                    issues.add("Sibling Stroke Mismatch", "info",
                               f"Node {state} while majority of siblings do the opposite",
                               c.get("id", ""), node_path(c, anc + [nd]))


# 11 ── Asymmetric padding ────────────────────────────────────────────────────

def check_asymmetric_padding(root, issues):
    if not FLAG_ASYMMETRIC_PADDING:
        return
    for nd, anc, _ in walk(root):
        al = nd.get("autoLayout")
        if not al or al.get("layoutMode") == "NONE":
            continue
        pt, pr, pb, pl = (al.get("paddingTop", 0), al.get("paddingRight", 0),
                          al.get("paddingBottom", 0), al.get("paddingLeft", 0))
        if pt != pb or pl != pr:
            issues.add("Asymmetric Padding", "info",
                       f"top={pt} right={pr} bottom={pb} left={pl}",
                       nd.get("id", ""), node_path(nd, anc))


# 12 ── Odd dimension + CENTER alignment ──────────────────────────────────────

def check_odd_center(root, issues):
    for nd, anc, _ in walk(root):
        al = nd.get("autoLayout")
        bb = bbox(nd)
        if not al or not bb:
            continue
        w, h = bb["width"], bb["height"]
        if w == int(w) and int(w) % 2 == 1 and al.get("counterAxisAlignItems") == "CENTER":
            issues.add("Odd Dimension + Center Alignment", "warning",
                       f"Width {int(w)}px (odd) + CENTER counter-axis → sub-pixel children",
                       nd.get("id", ""), node_path(nd, anc))
        if h == int(h) and int(h) % 2 == 1 and al.get("primaryAxisAlignItems") == "CENTER":
            issues.add("Odd Dimension + Center Alignment", "warning",
                       f"Height {int(h)}px (odd) + CENTER primary-axis → sub-pixel children",
                       nd.get("id", ""), node_path(nd, anc))


# 13 ── Excessive nesting ─────────────────────────────────────────────────────

def check_nesting(root, issues):
    for nd, anc, depth in walk(root):
        if depth > MAX_NESTING_DEPTH:
            issues.add("Excessive Nesting", "warning",
                       f"Depth {depth} exceeds threshold {MAX_NESTING_DEPTH}",
                       nd.get("id", ""), node_path(nd, anc))


# 14 ── Touch target size ─────────────────────────────────────────────────────

def check_touch_targets(root, issues):
    for nd, anc, _ in walk(root):
        bb = bbox(nd)
        if not bb or nd.get("type") not in ("FRAME", "INSTANCE", "COMPONENT"):
            continue
        if len(nd.get("children", [])) < INTERACTIVE_FRAME_MIN_CHILDREN:
            continue
        w, h = bb["width"], bb["height"]
        if w < MIN_TOUCH_TARGET_PX or h < MIN_TOUCH_TARGET_PX:
            issues.add("Touch Target Too Small", "warning",
                       f"{w}×{h}px < minimum {MIN_TOUCH_TARGET_PX}px",
                       nd.get("id", ""), node_path(nd, anc))


# 15 ── Hardcoded individual fills (no variable at array index) ───────────────

def check_hardcoded_fills(root, issues):
    for nd, anc, _ in walk(root):
        fills = nd.get("fills", [])
        bv_fills = nd.get("boundVariables", {}).get("fills", [])
        for i, f in enumerate(fills):
            if f.get("type") != "SOLID" or not f.get("color"):
                continue
            bound = (isinstance(bv_fills, list) and i < len(bv_fills)
                     and isinstance(bv_fills[i], dict) and bv_fills[i].get("type"))
            if not bound:
                issues.add("Hardcoded Fill (No Variable)", "info",
                           f"fills[{i}] color={f['color']} opacity={f.get('opacity', 1.0)}",
                           nd.get("id", ""), node_path(nd, anc))


# 16 ── Text contrast vs parent background ────────────────────────────────────

def check_contrast(root, issues):
    for nd, anc, _ in walk(root):
        if nd.get("type") != "TEXT" or not anc:
            continue
        fg = None
        for f in nd.get("fills", []):
            if f.get("type") == "SOLID" and f.get("color") and f.get("opacity", 1.0) >= 0.99:
                fg = f["color"]
                break
        if not fg:
            continue
        bg = None
        for a in reversed(anc):
            eff = composite_fills(a.get("fills", []), DEFAULT_BACKGROUND_HEX)
            if eff and eff.lower() != DEFAULT_BACKGROUND_HEX.lower():
                bg = eff
                break
        bg = bg or DEFAULT_BACKGROUND_HEX
        ratio = contrast_ratio(fg, bg)
        if ratio < MIN_CONTRAST_RATIO_AA:
            issues.add("Low Contrast (WCAG)", "error",
                       f"Ratio {ratio:.2f}:1 (fg={fg} bg={bg}) — below AA {MIN_CONTRAST_RATIO_AA}:1",
                       nd.get("id", ""), node_path(nd, anc))
        elif ratio < MIN_CONTRAST_RATIO_AAA:
            issues.add("Low Contrast (WCAG)", "info",
                       f"Ratio {ratio:.2f}:1 (fg={fg} bg={bg}) — passes AA, below AAA {MIN_CONTRAST_RATIO_AAA}:1",
                       nd.get("id", ""), node_path(nd, anc))


# 17 ── Unicode icons rendered as TEXT nodes ──────────────────────────────────

def check_text_icons(root, issues):
    """Structural: type==TEXT and characters is a single non-ASCII codepoint."""
    for nd, anc, _ in walk(root):
        if nd.get("type") != "TEXT":
            continue
        chars = (nd.get("characters") or "").strip()
        if 0 < len(chars) <= 2 and any(ord(c) > 0xFF for c in chars):
            issues.add("Icon as Text Character", "warning",
                       f"TEXT node holds unicode U+{ord(chars[0]):04X}"
                       " — should be a vector/component",
                       nd.get("id", ""), node_path(nd, anc))


# 18 ── layoutMode=NONE but padding > 0 (padding is ignored) ─────────────────

def check_dead_padding(root, issues):
    for nd, anc, _ in walk(root):
        al = nd.get("autoLayout")
        if not al or al.get("layoutMode") != "NONE":
            continue
        vals = [al.get("paddingTop", 0), al.get("paddingRight", 0),
                al.get("paddingBottom", 0), al.get("paddingLeft", 0)]
        if any(v > 0 for v in vals):
            issues.add("Ineffective Padding (No Auto Layout)", "warning",
                       f"layoutMode=NONE but padding={tuple(vals)} — has no effect",
                       nd.get("id", ""), node_path(nd, anc))


# 19 ── FIXED / FIXED on single-child Auto Layout ────────────────────────────

def check_fixed_single_child(root, issues):
    for nd, anc, _ in walk(root):
        al = nd.get("autoLayout")
        if not al:
            continue
        kids = nd.get("children", [])
        if len(kids) != 1:
            continue
        if (al.get("layoutSizingHorizontal") == "FIXED"
                and al.get("layoutSizingVertical") == "FIXED"):
            issues.add("Fixed Sizing With Single Child", "info",
                       "Auto Layout with 1 child uses FIXED/FIXED — consider HUG or FILL",
                       nd.get("id", ""), node_path(nd, anc))


# 20 ── Sibling cornerRadius mismatch ─────────────────────────────────────────

def check_corner_radius(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        rs = [(c, c["cornerRadius"]) for c in kids if "cornerRadius" in c]
        if len(rs) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        cr = majority([r for _, r in rs])
        for c, r in rs:
            if r != cr:
                issues.add("Sibling Corner Radius Mismatch", "warning",
                           f"cornerRadius={r} vs majority {cr}",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 21 ── Sibling node-type mismatch ────────────────────────────────────────────

def check_type_mismatch(root, issues):
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        ts = [(c, c.get("type")) for c in kids]
        ct = majority([t for _, t in ts])
        for c, t in ts:
            if t != ct:
                issues.add("Sibling Type Mismatch", "info",
                           f"Type '{t}' vs majority '{ct}'",
                           c.get("id", ""), node_path(c, anc + [nd]))


# 22 ── Sibling sizing-mode mismatch ──────────────────────────────────────────

def check_sizing_mismatch(root, issues):
    """Siblings with different layoutSizingHorizontal or layoutSizingVertical."""
    for nd, anc, _ in walk(root):
        kids = nd.get("children", [])
        if len(kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        al_kids = [(c, c["autoLayout"]) for c in kids if c.get("autoLayout")]
        if len(al_kids) < MIN_SIBLINGS_FOR_COMPARISON:
            continue
        for prop in ("layoutSizingHorizontal", "layoutSizingVertical"):
            vals = [(c, al.get(prop, "")) for c, al in al_kids]
            cv = majority([v for _, v in vals])
            for c, v in vals:
                if v != cv:
                    issues.add("Auto Layout Mismatch", "warning",
                               f"{prop}='{v}' vs majority '{cv}'",
                               c.get("id", ""), node_path(c, anc + [nd]))


# 23 ── Duplicate fills (exact same colour+opacity twice) ─────────────────────

def check_duplicate_fills(root, issues):
    for nd, anc, _ in walk(root):
        fills = nd.get("fills", [])
        if len(fills) < 2:
            continue
        seen = set()
        for i, f in enumerate(fills):
            key = (f.get("type"), f.get("color"), f.get("opacity", 1.0))
            if key in seen:
                issues.add("Duplicate Fill", "warning",
                           f"fills[{i}] is an exact duplicate (color={f.get('color')} opacity={f.get('opacity', 1.0)})",
                           nd.get("id", ""), node_path(nd, anc))
            seen.add(key)


# ═══════════════════════════════════════════════════════════════════════════════
# RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

ALL_CHECKS = [
    check_subpixel,
    check_overflow,
    check_sibling_dimensions,
    check_sibling_autolayout,
    check_bound_variables,
    check_styles,
    check_child_counts,
    check_fill_color_mismatch,
    check_fill_count,
    check_stroke_mismatch,
    check_asymmetric_padding,
    check_odd_center,
    check_nesting,
    check_touch_targets,
    check_hardcoded_fills,
    check_contrast,
    check_text_icons,
    check_dead_padding,
    check_fixed_single_child,
    check_corner_radius,
    check_type_mismatch,
    check_sizing_mismatch,
    check_duplicate_fills,
]


def run_audit(data: dict) -> Issues:
    issues = Issues()
    for fn in ALL_CHECKS:
        fn(data, issues)
    return issues


# ═══════════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Audit a Figma JSON export for design inconsistencies.")
    parser.add_argument("input", help="Path to the Figma JSON file")
    parser.add_argument("--output", "-o", help="Write JSON report to this path")
    parser.add_argument("--json", action="store_true",
                        help="Print JSON instead of text to stdout")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    issues = run_audit(data)

    if args.json:
        print(issues.json_report())
    else:
        print(issues.text_report())

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(issues.json_report())
        print(f"\nJSON report written to {args.output}", file=sys.stderr)

    return 1 if any(i["severity"] == "error" for i in issues.items) else 0


if __name__ == "__main__":
    sys.exit(main())
