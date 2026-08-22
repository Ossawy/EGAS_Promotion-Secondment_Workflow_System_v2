export const ADMIN_AUDIT_EVENT_LABELS:Record<string,string>={
  LOGIN_SUCCEEDED:'تسجيل دخول ناجح',LOGIN_FAILED:'محاولة تسجيل دخول غير ناجحة',LOGOUT:'تسجيل خروج',PASSWORD_CHANGED:'تغيير كلمة المرور',
  ACCOUNT_CREATED:'إنشاء حساب',ACCOUNT_UPDATED:'تعديل بيانات حساب',ACCOUNT_ENABLED:'تفعيل حساب',ACCOUNT_DISABLED:'تعطيل حساب',ACCOUNT_UNLOCKED:'فتح قفل حساب',PASSWORD_RESET:'إصدار كلمة مرور مؤقتة',
  OPERATIONAL_UNIT_CREATED:'إنشاء وحدة تشغيلية',MEMBERSHIP_TRANSFERRED:'نقل عضوية تشغيلية',MANAGER_REPLACED:'استبدال مدير وحدة',
  WORKFLOW_REQUEST_CREATED:'إنشاء طلب جديد',REQUEST_CANDIDATE_ADDED:'إضافة مرشح إلى الطلب',REQUEST_CANDIDATE_REMOVED:'إزالة مرشح من الطلب',
  WORK_ASSIGNMENT_CREATED:'إسناد عمل إلى موظف',STAGE_TAKEN_BY_MANAGER:'تولى المدير العمل بنفسه',STAGE_SUBMITTED_TO_MANAGER:'رفع العمل إلى المدير',INTERNAL_CORRECTION_REQUESTED:'طلب تصحيح داخلي',
  STAGE_RETURNED_TO_PREVIOUS:'إرجاع إلى المرحلة السابقة',WORKFLOW_REQUEST_REJECTED:'رفض الطلب',WORKFLOW_REQUEST_RESTARTED:'إعادة بدء الطلب',WORKFLOW_REQUEST_CANCELLED:'إلغاء الطلب',WORKFLOW_REQUEST_COMPLETED:'اكتمال الطلب',STAGE_ADVANCED:'الانتقال إلى المرحلة التالية',STAGE_SIGNED_AND_ADVANCED:'توقيع المرحلة والانتقال',WORKFLOW_NOTE_ADDED:'إضافة ملاحظة إلى الطلب',
  PROMOTION_DECISION_SAVED:'حفظ قرار ترقية',SECONDMENT_PREPARATION_SAVED:'حفظ بيانات الندب',SECONDMENT_OPTION_ADDED:'إضافة وظيفة مقترحة',SECONDMENT_OPTION_UPDATED:'تعديل وظيفة مقترحة',SECONDMENT_OPTION_REMOVED:'حذف وظيفة مقترحة',SECONDMENT_SELECTION_SAVED:'اعتماد وظيفة الندب',
  SIGNATURE_ASSET_UPLOADED:'رفع توقيع جديد',SIGNATURE_ASSET_DEACTIVATED:'إيقاف توقيع',SIGNATURE_PASSWORD_REJECTED:'رفض إعادة التحقق قبل التوقيع',
  IMPORT_BATCH_STAGED:'تجهيز ملف البيانات المعتمد',IMPORT_BATCH_VALIDATION_COMPLETED:'اكتمال فحص ملف البيانات',IMPORT_BATCH_REVALIDATED:'إعادة فحص ملف البيانات',IMPORT_BATCH_ACTIVATED:'تفعيل بيانات العاملين المعتمدة',
  ROUTING_ALIAS_CREATED:'إضافة اسم مرجعي لوحدة توجيه',ROUTING_ALIAS_UPDATED:'تعديل اسم مرجعي لوحدة توجيه',ROUTING_ALIAS_ENABLED:'تفعيل اسم مرجعي',ROUTING_ALIAS_DISABLED:'إيقاف اسم مرجعي'
}

export function adminAuditEventLabel(value:string):string{
  return ADMIN_AUDIT_EVENT_LABELS[value]??'حدث نظامي مسجل'
}
