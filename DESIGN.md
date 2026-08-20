---
name: Froe
description: A dark precision workshop for inspectable coding.
colors:
  ink: "#11100d"
  raised: "#211e17"
  chalk: "#f2ecde"
  paper: "#d8cfbd"
  muted: "#aa9f8c"
  brass: "#d9a927"
  brass-pale: "#f0ca62"
  line: "#5c5446"
  line-soft: "#342f27"
typography:
  display:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "clamp(4.15rem, 8.3vw, 6rem)"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "clamp(3.2rem, 6vw, 5.5rem)"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.58
  label:
    fontFamily: "SFMono-Regular, Cascadia Code, Liberation Mono, monospace"
    fontSize: "0.72rem"
    fontWeight: 400
    lineHeight: 1.58
    letterSpacing: "0.08em"
  code:
    fontFamily: "SFMono-Regular, Cascadia Code, Liberation Mono, monospace"
    fontSize: "clamp(0.73rem, 1.2vw, 0.9rem)"
    fontWeight: 400
    lineHeight: 1.72
rounded:
  none: "0"
spacing:
  compact: "0.75rem"
  standard: "1rem"
  room: "1.5rem"
  split: "2rem"
  wide: "3rem"
  section-min: "6rem"
components:
  primary-button:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.78rem 1.25rem"
  primary-button-hover:
    backgroundColor: "{colors.brass-pale}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.78rem 1.25rem"
  text-link:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0"
  text-link-hover:
    backgroundColor: "transparent"
    textColor: "{colors.brass-pale}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0"
  navigation:
    backgroundColor: "rgba(17, 16, 13, 0.97)"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    height: "5rem"
  run-stage-active:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.85rem 0.1rem 0.85rem 2.6rem"
  boundary-ledger:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "1.25rem 0"
  metadata-record:
    backgroundColor: "#0b0b09"
    textColor: "{colors.chalk}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "0"
  setup-terminal:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.chalk}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: "0"
  wedge-mark:
    backgroundColor: "transparent"
    textColor: "{colors.brass}"
    rounded: "{rounded.none}"
    size: "2rem"
---

# Design System: Froe

## Overview

**Creative North Star: "The Marking Bench"**

Froe is a dark precision workshop translated into an engineering layout sheet. Matte charcoal fields, chalk-white type, oxidized brass signals, and scored cut-lines make the interface feel measured and workmanlike without imitating a physical object.

The system is flat, exact, direct, and inspectable. Tonal fields and rule lines expose structure, while one precise wedge gives the world its own silhouette and marks the cut from intent to evidence. Motion behaves like a measured proof passing across the work, never as ambient decoration.

**Key Characteristics:**

- Matte charcoal fields carry the working surface.
- Chalk-white and warm paper tones establish reading hierarchy.
- Oxidized brass is the sole chromatic signal.
- Straight edges and cut-lines replace rounded cards and shadows.
- A precise wedge marks decisive transitions without becoming a pattern.

## Colors

The palette is warm, mineral, and deliberately narrow: charcoal provides the bench, chalk and paper carry language, and brass marks consequence.

### Primary

- **Oxidized Brass:** Primary actions, selected Run stages, proof lines, the boundary field, and the signature wedge.
- **Pale Brass:** Hover emphasis, highlighted display words, evidence titles, and status language that needs to read above the base brass.

### Neutral

- **Coal Ink:** The page ground, terminal ground, and foreground used when brass becomes a field.
- **Raised Charcoal:** The only raised tonal field, reserved for the installation section.
- **Chalk White:** Display type, strong text, and the brightest structural rules.
- **Work Paper:** Body copy, navigation, and secondary reading text.
- **Tool Dust:** Metadata, captions, tertiary text, and quiet code annotations.
- **Scored Line:** Primary separators, terminal borders, and the visible scrollbar thumb.
- **Faint Cut Line:** Nested dividers and low-emphasis structure.

When the visitor requests more contrast, Tool Dust, Scored Line, and Faint Cut Line become lighter without introducing another hue.

### Named Rules

**The One Signal Rule.** Brass is the only chromatic signal; use it for action, state, evidence, and decisive boundaries, never for ambient decoration.

**The Contrast Flip Rule.** When brass becomes a full field, Coal Ink carries every foreground role and line rather than adding a new inverse palette.

## Typography

**Display Font:** Barlow Condensed (with sans-serif fallback)  
**Body Font:** Atkinson Hyperlegible Next (with sans-serif fallback)  
**Label/Mono Font:** SFMono-Regular, Cascadia Code, or Liberation Mono

**Character:** The condensed display face lands like a workshop marking: compressed, uppercase, and decisive. The hyperlegible body face keeps dense technical claims calm, while the system mono stack is reserved for code, state, sequence, and measurement.

### Hierarchy

- **Display** (600, fluid 4.15–6rem, 0.92 line-height): Hero statements only; uppercase and tightly tracked.
- **Headline** (600, fluid 3.2–5.5rem, 0.92 line-height): Major section propositions; uppercase and short enough to form a block.
- **Title** (600, 1.05rem, 1.3 line-height): Action names and compact subheads inside structured content.
- **Body** (400, 1rem, 1.58 line-height): Explanations and product truth, usually constrained between 42ch and 66ch.
- **Label** (400, 0.72rem, 0.08em tracking): Uppercase metadata, captions, sequence indices, states, and column headings.
- **Code** (400, fluid 0.73–0.9rem, 1.72 line-height): Commands and structured records.

### Named Rules

**The Voice Split Rule.** Barlow Condensed speaks only in display headings and the wordmark; mono speaks only when the interface is showing code, data, state, sequence, or measurement.

**The Short Block Rule.** Display copy stays brief and balanced so the condensed capitals form a stable geometric mass instead of a paragraph.

## Layout

The desktop shell is capped at 90rem with 1.5rem side gutters. Major sections use asymmetric two-column grids: a compact proposition column faces a wider mechanism or evidence column, with responsive gaps from 4rem to 10rem. Section depth scales fluidly from a 6rem minimum rather than accumulating small card padding.

At 68rem the navigation collapses and wide sequences simplify. At 56rem the hero and major section grids stack into a single column and the wedge rotates from a vertical split into a horizontal cut. At 40rem actions, facts, ledgers, retention lists, and footer links reflow into linear reading order; labels move beside the values they qualify.

The working rhythm favors repeated 0.75rem, 1rem, 1.5rem, 2rem, and 3rem intervals. Layout is allowed to be spacious, but alignment stays hard and every break follows content structure.

### Named Rules

**The Split-Surface Rule.** Pair propositions with mechanisms across an asymmetric cut; on narrow screens preserve the sequence by stacking them rather than shrinking the mechanism.

## Elevation & Depth

The system uses no shadows. Depth comes from the progression between Coal Ink and Raised Charcoal, full-field brass inversions, and borders that reveal where one piece of evidence ends and another begins. A surface earns distinction through tone or a cut-line, not simulated lift.

### Named Rules

**The No Shadow Rule.** Keep every surface flat; use tonal contrast and one- or two-pixel cut-lines to establish hierarchy.

**The Cut-Line Rule.** Lines are structural evidence. Use stronger Chalk White or Coal Ink rules for major cuts and quieter neutral rules for nested divisions.

## Shapes

Corners remain square throughout. Buttons, terminals, records, ledgers, stages, and navigation fields are rectilinear; one-pixel rules handle ordinary divisions, while two-pixel rules mark a major boundary. The recurring non-rectangular forms are the beveled wedge mark and the rotated-square Run marker.

### Named Rules

**The One Wedge Rule.** Use one precise wedge to indicate the cut between intent and evidence; do not scatter wedges as decoration or soften them into rounded motifs.

## Components

### Primary Button

- **Shape:** Square and compact, with a 3.2rem minimum height and 0.78rem × 1.25rem internal padding.
- **Primary:** Oxidized Brass fill with Coal Ink text and semibold body typography.
- **Hover / Focus:** Hover moves to Pale Brass. Keyboard focus uses a 0.2rem Pale Brass outline with a 0.25rem offset.

### Text Link

- **Style:** Warm paper text, medium body weight, and a narrow inline arrow drawn as an SVG stroke.
- **Hover / Focus:** Hover changes the text to Pale Brass and moves the arrow 0.25rem over 180ms; focus uses the global offset outline.

### Navigation

- **Style:** A sticky five-rem header uses a three-column layout for wordmark, section links, and source action over translucent Coal Ink. Navigation text stays compact and undecorated until hover.
- **Responsive:** Section links disappear below 68rem while the wordmark and source action remain; the header becomes non-sticky below 40rem.

### Interactive Run Cross-Section

- **Structure:** A ruled figure combines caption, vertical proof rail, six stage buttons, and a live evidence readout.
- **State:** The active stage flips to Oxidized Brass with Coal Ink text; the rail and diamond marker advance over 520ms with the standard ease-out curve.
- **Motion:** One 900ms evidence pass crosses the component on first entry. Reduced-motion preference makes every transition effectively instant.

### Boundary Ledger

- **Structure:** A full Oxidized Brass field supports a three-column ledger divided by Coal Ink rules; labels and values align like an engineering register.
- **Responsive:** Below 40rem the column header disappears and each row becomes a labeled vertical record.

### Metadata Record Panel

- **Structure:** A near-black, square-cornered figure uses Chalk White outer rules, faint internal divisions, a mono caption, and a horizontally scrollable code area.
- **Syntax:** Tool Dust lowers syntax scaffolding, Pale Brass identifies keys, and Work Paper carries values.

### Setup Terminal

- **Structure:** Coal Ink sits inside a Scored Line border, with a compact heading row above a mono command block.
- **Action:** The copy control is a text action with a brass underline; success or failure appears as live Pale Brass status text and clears after the response window.

### Wedge Mark

- **Style:** An outlined, square-capped SVG wedge serves as the wordmark symbol, while the hero uses the same cut logic as a solid brass field.
- **Use:** Keep the mark optically sharp, unrounded, and free of effects.

## Do's and Don'ts

### Do:

- **Do** use brass sparingly for action, active state, evidence, and explicit boundaries.
- **Do** expose hierarchy through tonal fields, exact alignment, and cut-lines.
- **Do** keep display, reading, and measurement voices in their assigned type families.
- **Do** preserve the wedge as a singular signature at decisive transitions.
- **Do** keep keyboard focus visible and make purposeful motion instant for reduced-motion users.

### Don't:

- **Don't** add rounded corners, shadows, glows, or floating-card depth.
- **Don't** introduce extra accent hues or use brass as background ornament.
- **Don't** turn mechanisms or evidence into interchangeable feature cards.
- **Don't** use display type for paragraphs or mono type as decorative texture.
- **Don't** add looping, ambient, or ornamental motion.
