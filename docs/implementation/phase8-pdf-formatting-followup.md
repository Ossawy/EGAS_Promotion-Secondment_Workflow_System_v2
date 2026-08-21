# Phase 8 — Official PDF Formatting Follow-up

## Purpose

Phase 6 established the functional and evidentiary PDF implementation for
Promotion and Secondment:

- immutable final-form snapshots
- frozen workflow/signature evidence
- checksum-protected PDF materialization
- correct Promotion and Secondment field mappings
- RTL Arabic rendering
- official signer evidence
- final and audit PDF access controls

The PDFs are functionally accepted for Phase 6.

Phase 8 will perform a dedicated visual-formatting and official-form fidelity
pass without changing the approved workflow or immutable evidence model.

---

## Important Boundary

Phase 8 PDF work is primarily PRESENTATION / RENDERING work.

Do not change business semantics merely to improve visual layout.

Preserve:

- Promotion P1/P2/P4 signatures
- Secondment S1/S2/S3 signatures
- frozen final_form_snapshot evidence
- frozen S2/S3 Secondment evidence
- Promotion P4 recommendation/target/notes evidence
- XLSX-to-candidate frozen mappings
- PDF checksum/materialization behavior
- historical signature assets
- workflow authorization and stage logic

If a formatting request appears to require changing business data semantics,
stop and review it separately.

---

# Promotion PDF Follow-up

Current functional mapping is approved:

- رقم العامل -> frozen personnelNumber
- اسم المرشح -> frozen employeeName
- المؤهل الدراسي وتاريخه ->
  frozen qualification institution + certificate + date
- الوظيفة الحالية -> frozen currentJobTitle
- الإدارة العامة -> frozen sourceRoutingLabel
  (`النيابة / المساعد` from the annual workbook)
- تاريخ شغلها -> frozen currentJobStartDate
- مدة الخبرة -> frozen 1/1 years/months/days triplet
- التوصية -> frozen P4 recommendation
- الوظيفة المرشح لشغلها -> frozen P4 effective nominated job
- آخر تقرير كفاية سنوي -> frozen performanceRating
- ملاحظات -> frozen P4 candidate notes

Phase 8 visual improvements should review:

1. Closer fidelity to the photographed official Promotion form.
2. Header spacing and metadata alignment.
3. Arabic typography, line spacing, and vertical centering.
4. Column width balance.
5. Recommendation sub-columns alignment.
6. Experience day/month/year sub-header alignment.
7. Qualification/date presentation.
8. Long notes wrapping.
9. Page break aesthetics.
10. Repeated table-header appearance.
11. Signature image sizing and placement.
12. Footer spacing and official-form visual hierarchy.
13. Logo size/position if a better official reference becomes available.
14. Removal of visual-QA-only artificial long sample values from final
    reference fixtures where they are no longer useful.

Do not restore unsupported employee-subgroup-derived Promotion category rows.
If EGAS later supplies an authoritative Promotion category/section mapping,
implement it from approved frozen evidence only.

---

# Secondment PDF Follow-up

Current functional mapping is approved:

- اسم المرشح -> frozen employeeName
- الوظيفة الحالية -> frozen currentJobTitle
- المؤهل الدراسي وتاريخه ->
  frozen qualification institution + certificate + date
- تقرير آخر ترقية -> mandatory frozen S2 lastPromotionReport
- الوظائف الشاغرة والتى يجوز الندب لشغلها ->
  all authoritative frozen S2 options
- التبعية التنظيمية ->
  frozen S2 organizationalDependency
- استيفاء / عدم استيفاء مطالب تأهيل شغل الوظيفة ->
  frozen S2 qualification display
- selected option -> frozen S3 selectedOptionId
- ملاحظات -> frozen current-iteration candidate notes
- category row -> frozen S2 jobCategoryName

Current approved title:

بيان بموقف الوظائف التى يمكن شغلها (ندب) بالمستوى الأول فأقل

Phase 8 visual improvements should review:

1. Notes column width/readability.
2. Long qualification-status wrapping.
3. Multiple S2 option sub-row spacing.
4. Alignment of selected-option indicator.
5. Candidate-row versus additional-option-row visual distinction.
6. Category-header spacing and shading.
7. Serial-number reset presentation.
8. Long organizational-dependency wrapping.
9. Page-break behavior when one candidate has many S2 options.
10. Footer/signature spacing.
11. Overall fidelity to the approved Secondment reference form.

The current narrow notes column is accepted for Phase 6, but should receive
specific attention in Phase 8.

---

# Shared Arabic Rendering Follow-up

Phase 6 established the required Arabic rendering approach:

logical Arabic text
-> wrap into logical lines
-> visual RTL conversion per fitted line
-> draw prepared lines without allowing PDFKit to wrap them again

Do not reintroduce:

- whole-paragraph word reversal
- top-to-bottom line reversal
- double wrapping
- bidi control characters that render as visible glyphs

Mixed Arabic/Latin fields such as IDs and ISO dates should remain isolated
from Arabic visual conversion where appropriate.

---

# Signature Formatting Follow-up

Approved evidence remains:

Promotion:
- HR
- ORG
- AUTH

Secondment:
- HR
- ORG
- AUTH

Current visible signer structure:

1. frozen effective job title
2. frozen signer name
3. frozen signature image

Do not restore:

- الاسم:
- الوظيفة:
- التوقيع:
- visible signing timestamp
- department headings removed during Phase 6

Phase 8 may adjust only visual placement, spacing, size, and typography.

---

# Phase 8 Exit Criteria

PDF formatting work can be considered complete when:

- Promotion visually matches the approved official reference as closely as
  practical.
- Secondment visually matches its approved reference.
- Arabic is natural and correctly ordered everywhere.
- No clipping occurs with representative real data.
- multi-page forms remain readable.
- multiple Secondment options paginate correctly.
- signature images remain legible.
- visual improvements do not introduce live-data dependencies.
- immutable snapshot and checksum tests remain green.
- full API regression remains green.