---
name: Institutional Administrative Framework
colors:
  surface: '#f7faf4'
  surface-dim: '#d8dbd5'
  surface-bright: '#f7faf4'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f5ee'
  surface-container: '#ecefe8'
  surface-container-high: '#e6e9e3'
  surface-container-highest: '#e0e3dd'
  on-surface: '#191d19'
  on-surface-variant: '#404941'
  inverse-surface: '#2d312d'
  inverse-on-surface: '#eff2eb'
  outline: '#707a70'
  outline-variant: '#bfc9be'
  surface-tint: '#266b40'
  primary: '#004321'
  on-primary: '#ffffff'
  primary-container: '#135c33'
  on-primary-container: '#8cd29e'
  inverse-primary: '#90d6a2'
  secondary: '#5c5f61'
  on-secondary: '#ffffff'
  secondary-container: '#e0e3e5'
  on-secondary-container: '#626567'
  tertiary: '#2a3a4f'
  on-tertiary: '#ffffff'
  tertiary-container: '#415167'
  on-tertiary-container: '#b3c4dd'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#abf3bc'
  primary-fixed-dim: '#90d6a2'
  on-primary-fixed: '#00210d'
  on-primary-fixed-variant: '#02522a'
  secondary-fixed: '#e0e3e5'
  secondary-fixed-dim: '#c4c7c9'
  on-secondary-fixed: '#191c1e'
  on-secondary-fixed-variant: '#444749'
  tertiary-fixed: '#d3e4fe'
  tertiary-fixed-dim: '#b7c8e1'
  on-tertiary-fixed: '#0b1c30'
  on-tertiary-fixed-variant: '#38485d'
  background: '#f7faf4'
  on-background: '#191d19'
  surface-variant: '#e0e3dd'
typography:
  display-lg:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
  display-lg-mobile:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
  headline-md:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-sm:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-sm:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  sidebar-width: 280px
  header-height: 72px
  container-max-width: 1440px
  gutter: 24px
  margin-mobile: 16px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

## Brand & Style

This design system is built to reflect the authoritative and national importance of the Egyptian Natural Gas Holding Company (EGAS). The aesthetic is **Corporate / Modern**, leaning heavily on structured layouts, institutional reliability, and high legibility. It is designed to facilitate complex administrative workflows, HR approvals, and data management with a focus on trust and efficiency.

The personality is formal yet modern, moving away from legacy bureaucratic clutter toward a streamlined, "service-first" digital experience. While primarily serving an Arabic-speaking workforce, the design system maintains a bilingual structural integrity, ensuring that professional standards are met across all touchpoints.

## Colors

The palette is anchored by a **Deep Institutional Green** derived from the official logo, symbolizing growth and national energy. This is paired with a clean white and cool-gray background system to reduce cognitive load during long working sessions.

- **Primary:** Used for brand identifiers, primary actions, and active navigation states.
- **Surface:** A tiered system of light grays (#F8FAFC, #F1F5F9) distinguishes the sidebar and background from the white content cards.
- **Semantic Accents:** Standardized colors for status tracking:
    - **Emerald:** Completed/Approved requests.
    - **Amber:** Returned/Pending Action.
    - **Blue:** In-Progress/Processing.
    - **Red:** Rejected/Canceled.

## Typography

We utilize **IBM Plex Sans Arabic** for its exceptional technical clarity and professional skeletal structure. It bridges the gap between traditional calligraphic shapes and modern digital requirements, making it ideal for data-heavy administrative portals.

### RTL Considerations
- All typography must be right-aligned by default.
- Line heights are slightly increased compared to standard Latin sets to accommodate the descenders and ascenders of the Arabic script without crowding.
- Numerical data in tables should use localized numerals or standard Western numerals based on specific regional HR requirements, but font weight must remain consistent.

## Layout & Spacing

The layout follows a **Fluid Grid** model with a sidebar-based navigation structure typical of modern SaaS and ERP systems. 

- **Desktop (1024px+):** A 12-column grid with a fixed right-side (or left-side in LTR) navigation drawer. Content is housed in a central fluid container with a maximum width of 1440px.
- **Mobile (<768px):** The sidebar collapses into a hamburger menu. The 12-column grid collapses to 4 columns.
- **RTL Logic:** The design system is mirrored. The primary navigation sidebar sits on the **right** for Arabic locales. Icons that denote direction (like arrows for "next") must be flipped.

Spacing uses a strict 8px base unit to ensure alignment across complex data tables and multi-input forms.

## Elevation & Depth

To maintain a formal, institutional feel, this design system avoids heavy shadows in favor of **Tonal Layers** and **Low-Contrast Outlines**.

- **Level 0 (Background):** Light gray (#F1F5F9). Used for the base canvas.
- **Level 1 (Sidebar/Header):** White with a subtle 1px border (#E2E8F0) to separate navigation from content.
- **Level 2 (Cards/Tables):** White surface with a very soft, diffused shadow (0px 2px 4px rgba(0,0,0,0.05)) to suggest interactivity without appearing "playful."
- **Focus States:** High-visibility 2px borders using the Primary Green to ensure accessibility during keyboard navigation.

## Shapes

The design uses **Soft (0.25rem)** roundedness to maintain a precise, professional atmosphere. 

- **Standard Elements:** Buttons, input fields, and small cards use a 4px (0.25rem) radius.
- **Large Containers:** Dashboard widgets and main content areas use an 8px (0.5rem) radius.
- **Status Badges:** Use a "Pill" shape (full rounding) to clearly distinguish them from actionable buttons or input fields.

## Components

### Buttons
- **Primary:** Solid Deep Green with white text. High emphasis.
- **Secondary:** Outline in Primary Green or Slate Gray. Used for "Cancel" or "Back."
- **Ghost:** No border, Primary Green text. Used for less frequent actions in tables.

### Tables
Professional tables are the core of the portal. Use alternating row stripes (Zebra) in very light gray for readability. Headers should be sticky with a semi-bold weight and a subtle bottom border.

### Status Badges
Small, high-contrast pills. 
- *Emerald background with Dark Emerald text* for "Approved."
- *Amber background with Dark Amber text* for "Returned."

### Input Fields
Label-top alignment is mandatory for better scanability in forms. Fields use a white background with a 1px Slate-200 border, turning Primary Green on focus.

### Sidebar Navigation
The sidebar should use "Active" states that include a 4px vertical bar on the leading edge (right side in Arabic) in Primary Green, along with a subtle background tint.