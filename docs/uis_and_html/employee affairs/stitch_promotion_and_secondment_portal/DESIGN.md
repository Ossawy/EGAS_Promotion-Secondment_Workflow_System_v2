---
name: EGAS Enterprise Core
colors:
  surface: '#f8faf5'
  surface-dim: '#d8dbd6'
  surface-bright: '#f8faf5'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4ef'
  surface-container: '#ecefe9'
  surface-container-high: '#e6e9e4'
  surface-container-highest: '#e1e3de'
  on-surface: '#191c19'
  on-surface-variant: '#404942'
  inverse-surface: '#2e312e'
  inverse-on-surface: '#eff2ec'
  outline: '#707971'
  outline-variant: '#bfc9bf'
  surface-tint: '#296a46'
  primary: '#00341c'
  on-primary: '#ffffff'
  primary-container: '#004d2c'
  on-primary-container: '#7bbd93'
  inverse-primary: '#92d5a9'
  secondary: '#386851'
  on-secondary: '#ffffff'
  secondary-container: '#b7ebcf'
  on-secondary-container: '#3c6c55'
  tertiary: '#52181e'
  on-tertiary: '#ffffff'
  tertiary-container: '#6e2e33'
  on-tertiary-container: '#ef979b'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#aef2c4'
  primary-fixed-dim: '#92d5a9'
  on-primary-fixed: '#002110'
  on-primary-fixed-variant: '#085230'
  secondary-fixed: '#baeed1'
  secondary-fixed-dim: '#9fd2b6'
  on-secondary-fixed: '#002114'
  on-secondary-fixed-variant: '#1f4f3a'
  tertiary-fixed: '#ffdada'
  tertiary-fixed-dim: '#ffb3b5'
  on-tertiary-fixed: '#3b070f'
  on-tertiary-fixed-variant: '#733237'
  background: '#f8faf5'
  on-background: '#191c19'
  surface-variant: '#e1e3de'
  status-review: '#005691'
  status-approved: '#006d2f'
  status-pending: '#9a6b00'
  status-rejected: '#b91c1c'
  neutral-surface: '#ffffff'
  neutral-subtle: '#f3f4f6'
  border-standard: '#e5e7eb'
typography:
  headline-lg:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
  headline-md:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 30px
  headline-sm:
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
  body-sm:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-lg:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-md:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  label-sm:
    fontFamily: IBM Plex Sans Arabic
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.02em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-desktop: 32px
  table-cell-padding: 12px
---

## Brand & Style

This design system is tailored for the EGAS HR ecosystem, emphasizing **Corporate reliability, high-trust, and institutional stability**. The brand personality is formal and precise, designed to facilitate complex administrative workflows without visual distraction. 

The visual style is **Corporate Modern**, drawing inspiration from the SAP Fiori framework to ensure a functional, "tools-not-toys" atmosphere. It utilizes a flat design language with structural clarity, relying on high-contrast typography and a restrained application of the EGAS green to denote authority. The interface prioritizes high information density and structural alignment, providing a sense of order essential for enterprise-grade human resource management.

## Colors

The color strategy is strictly professional, utilizing a white-base methodology to maintain a clean, clinical environment. 

- **Primary (#004d2c):** The official EGAS green. Reserved for primary actions, navigational active states, and key brand moments.
- **Secondary (#2e5e48):** A desaturated variation used for secondary UI elements and hover states to maintain the green theme without overwhelming the user.
- **Workflow Status Colors:** Functionally distinct hues are used for status mapping:
    - **Review (Blue):** Systematic and calm.
    - **Approved (Green):** Confirmatory and positive.
    - **Pending (Yellow):** Cautionary but not alarming.
    - **Rejected (Red):** Immediate attention required.
- **Neutral Palette:** Relies on high-quality grays (Slate/Gray scales) for text and structural borders to ensure the interface feels grounded and serious.

## Typography

The design system uses **IBM Plex Sans Arabic** to provide a neutral, technical typeface that excels in professional environments. 

- **RTL Priority:** Line heights are specifically tuned for Arabic script, which requires more vertical breathing room than Latin characters to remain legible at small sizes.
- **Hierarchy:** We use SemiBold (600) for headers to command attention and Medium (500) for labels to provide a distinct visual anchor for data entry.
- **Legibility:** Body text is primarily kept at 14px (body-md) for data-heavy views, ensuring high information density while maintaining accessibility standards.

## Layout & Spacing

The layout follows a **Fixed Grid** approach for internal enterprise tools to ensure consistent data alignment across various desktop screen sizes.

- **Grid:** A 12-column grid system is used for dashboards, while a single-column centered layout (800px max-width) is used for formal application forms.
- **RTL (Right-to-Left):** The layout is natively RTL. Sidebars are anchored to the right, and the reading gravity flows right-to-left.
- **Density:** We employ a 4px baseline grid. For enterprise data tables, padding is kept tight (12px) to allow as many rows and columns as possible to be visible without scrolling.
- **Breakpoints:**
  - Desktop: 1440px+
  - Laptop: 1024px - 1439px
  - Tablet (Reflow): 768px - 1023px

## Elevation & Depth

To maintain the **Flat, SAP Fiori-inspired** aesthetic, the design system avoids traditional drop shadows in favor of **Tonal Layers** and **Low-contrast Outlines**.

- **Surfaces:** Depth is achieved by varying the lightness of the background. The main canvas is `#f9fafb`, while primary workspace containers (cards) are pure white `#ffffff`.
- **Borders:** Structural hierarchy is reinforced using 1px borders in `#e5e7eb`. 
- **Active States:** Subtle 1px inset shadows or a 2px primary-color border are used to indicate focus or selection. 
- **No Diffusion:** High-blur shadows are forbidden. If a modal requires elevation, it uses a sharp 2px or 4px hard-edged border or a very tight, low-opacity (10%) neutral shadow.

## Shapes

The shape language is **Soft (0.25rem)**. This provides a professional touch without looking overly "consumer" or casual.

- **Input Fields & Buttons:** 4px radius ensures they feel like sturdy, mechanical components.
- **Enterprise Cards:** 4px radius with a 1px border.
- **Status Chips:** Small 2px radius (near-sharp) to differentiate them from interactive buttons.
- **Workflow Timelines:** Use 90-degree corners for the track and 50% rounded (circle) indicators for progress nodes.

## Components

- **Dense Data Tables:** The core of the HR system. Tables feature frozen headers, zebra-striping (using `#f3f4f6`), and text-alignment that respects RTL (numeric data is often right-aligned for better comparison).
- **Enterprise Cards:** Used for employee summaries and role details. They feature a 1px `#e5e7eb` border and a dedicated header area with a `#f9fafb` background.
- **Status Chips:** Small, rectangular tags with light background fills (10% opacity of the status color) and high-contrast text. Labels are in Arabic (e.g., "مقبول", "قيد المراجعة").
- **Workflow Timelines:** A vertical or horizontal progression indicator showing the path of a secondment application. Completed steps use the EGAS green; active steps use a primary outline.
- **Input Fields:** Flat design with a 1px border on all sides. The label is placed above the field in `label-md` weight.
- **Buttons:**
    - **Primary:** Solid `#004d2c` with white text.
    - **Secondary:** White background with a `#004d2c` 1px border and text.
    - **Ghost:** No border, used for utility actions like "Cancel" or "Go Back".