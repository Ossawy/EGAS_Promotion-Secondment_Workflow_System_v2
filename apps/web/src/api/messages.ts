import { ApiError } from './client'

const CODE_MESSAGES: Record<string, string> = {
  // Generic
  REQUEST_FAILED: 'تعذر إتمام الطلب. يرجى المحاولة مرة أخرى.',
  AUTHENTICATION_REQUIRED: 'يجب تسجيل الدخول أولاً.',
  AUTHENTICATION_FAILED: 'بيانات الدخول غير صحيحة.',
  VALIDATION_FAILED: 'تحقق من صحة البيانات المدخلة.',
  CSRF_INVALID: 'انتهت صلاحية الجلسة. حدّث الصفحة وحاول مجدداً.',

  // Identity / hierarchy
  OPERATIONAL_REQUIRED: 'هذا الإجراء متاح للحسابات التشغيلية فقط.',
  HR_MANAGER_REQUIRED: 'يتطلب هذا الإجراء صلاحية مدير الموارد البشرية الحالي.',
  UNIT_MANAGER_REQUIRED: 'يتطلب هذا الإجراء صلاحية مدير الوحدة الحالي.',
  UNIT_MEMBERSHIP_REQUIRED: 'المستخدم المستهدف ليس عضواً نشطاً في هذه الوحدة.',
  MANAGER_REPLACEMENT_REQUIRED: 'يجب استبدال مدير الوحدة أولاً قبل نقل عضويته أو تعطيل حسابه.',
  LAST_ADMIN_REQUIRED: 'لا يمكن تعطيل آخر حساب إدارة نشط في النظام.',

  // Requests / candidates
  REQUEST_NOT_FOUND: 'الطلب غير موجود أو لا تملك صلاحية الاطلاع عليه.',
  INVALID_REQUEST_TYPE: 'نوع الطلب غير صحيح.',
  ROUTING_UNIT_NOT_FOUND: 'النيابة المحددة غير موجودة أو غير نشطة.',
  REQUEST_NOT_DRAFT: 'لا يمكن تعديل المرشحين إلا أثناء مرحلة التحضير (مسودة).',
  STAGE_NOT_INITIAL: 'إضافة أو إزالة المرشحين متاحة فقط في مرحلة الإعداد الأولى P1/S1.',
  PERSONNEL_NUMBER_REQUIRED: 'أدخل رقم الموظف أولاً.',
  EMPLOYEE_NOT_FOUND: 'لم يتم العثور على الموظف في أحدث لقطة سنوية مفعّلة.',
  CANDIDATE_ROUTING_MISMATCH: 'نيابة الموظف لا تطابق نيابة الطلب. اختر موظفاً من نفس النيابة.',
  CANDIDATE_DUPLICATE: 'تمت إضافة هذا الموظف مسبقاً إلى الطلب.',
  CANDIDATE_NOT_FOUND: 'المرشح غير موجود بهذا الطلب.',

  // Stage execution
  STAGE_NOT_FOUND: 'مرحلة التنفيذ غير موجودة.',
  STAGE_NOT_CURRENT: 'تغيّرت حالة الطلب. حدّث الطلب وأعد المحاولة.',
  STAGE_NOT_OPEN: 'هذه المرحلة لم تعد مفتوحة. حدّث الطلب لعرض الحالة الحالية.',
  NOT_ACTIVE_ASSIGNEE: 'أنت لم تعد الموظف المسند إليه هذه المرحلة. حدّث الطلب.',
  NO_SUBORDINATE_ASSIGNEE: 'لا يوجد موظف مسند لهذه المرحلة لإعادة العمل إليه.',
  INVALID_WORK_STATE: 'لا يمكن تنفيذ هذا الإجراء في حالة العمل الحالية. حدّث الطلب.',
  REASON_REQUIRED: 'يرجى إدخال السبب المطلوب.',
  RETURN_INVALID: 'لا يمكن إرجاع هذه المرحلة إلى مرحلة سابقة.',
  SIGNATURE_REQUIRED: 'هذه المرحلة تتطلب توقيعاً رسمياً قبل المتابعة.',
  STAGE_ADVANCE_UNSUPPORTED: 'لا يمكن المتابعة من هذه المرحلة بهذا الإجراء.',
  REQUEST_NOT_REJECTED: 'هذا الإجراء متاح فقط للطلبات المرفوعة لقرار الموارد البشرية.',

  // Signing
  SIGNATURE_PASSWORD_INVALID: 'كلمة المرور غير صحيحة. لم يتم إنشاء أي توقيع ويمكنك المحاولة مجدداً.',
  SIGNATURE_BODY_REQUIRED: 'ملف صورة التوقيع مطلوب.',
  SIGNATURE_ASSET_INVALID: 'التوقيع المحدد غير صالح. اختر توقيعاً نشطاً.',
  SIGNATURE_MIME_UNSUPPORTED: 'صيغة صورة التوقيع غير مدعومة. استخدم PNG أو JPEG.',
  SIGNATURE_TOO_LARGE: 'حجم صورة التوقيع يتجاوز الحد المسموح.',
  SIGNATURE_DIMENSIONS_TOO_LARGE: 'أبعاد صورة التوقيع أكبر من الحد المسموح.',
  MANAGER_ASSIGNMENT_MISSING: 'تغيّرت إدارة الوحدة أثناء التوقيع. حدّث الصفحة وأعد المحاولة.',
  MANAGER_ASSIGNMENT_CONFLICT: 'تعارض في تحديث تعيين المدير. حاول مجدداً.',

  // Promotion / Secondment domain
  PROMOTION_DECISION_INVALID: 'قرار الترقية غير صحيح. تحقق من نوع القرار والوظيفة المستهدفة.',
  PROMOTION_TARGET_JOB_TITLE_REQUIRED: 'حدد المسمى الوظيفي المستهدف للترقية على وظيفة أخرى.',
  PROMOTION_TARGET_SAME_POSITION_CONFLICT: 'لا يمكن تحديد وظيفة مستهدفة عند اختيار الترقية على نفس الوظيفة.',
  PROMOTION_TARGET_UNCHANGED: 'يجب أن يختلف المسمى المستهدف عن الوظيفة الحالية للموظف.',
  PROMOTION_DEPARTMENT_REQUIRED: 'بيانات الإدارة العامة/القسم غير متوفرة في البيانات السنوية لهذا الموظف. راجع مصدر البيانات الرسمي.',
  PROMOTION_DECISIONS_INCOMPLETE: 'يجب استكمال قرار سلطة الاعتماد لكل مرشح قبل المتابعة.',
  SECONDMENT_PREPARATION_INCOMPLETE: 'استكمل بيانات إعداد المرشح (تقرير آخر ترقية وفئة الوظيفة) قبل المتابعة.',
  SECONDMENT_OPTIONS_INCOMPLETE: 'يجب إضافة خيار وظيفة مقترح واحد على الأقل لكل مرشح قبل المتابعة.',
  SECONDMENT_SELECTIONS_INCOMPLETE: 'يجب اختيار وظيفة واحدة لكل مرشح قبل المتابعة.',
  SECONDMENT_OPTION_INVALID: 'خيار الوظيفة المقترحة غير صالح أو غير تابع للمرشح المحدد.',
  SECONDMENT_SELECTION_INVALID: 'الاختيار المحدد غير صالح. اختر أحد الخيارات المعتمدة من المرحلة السابقة.',
  QUALIFICATION_STATUS_INVALID: 'حالة التأهيل المحددة غير معروفة في مرجع الحالات.',

  // Documents / notifications
  DOCUMENT_NOT_AVAILABLE: 'المستند المطلوب غير متاح بعد.',
  NOTIFICATION_NOT_FOUND: 'الإشعار غير موجود.'
}

export function arabicErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return CODE_MESSAGES[error.code] ?? error.message
  }
  if (error instanceof Error && error.message) return error.message
  return 'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.'
}
