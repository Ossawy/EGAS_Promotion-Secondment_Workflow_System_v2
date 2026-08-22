import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { signatureApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { SignatureAssetView } from '../api/workflow-types'

const MAX_UPLOAD_BYTES = 1_048_576
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg'])

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

/** Manage the current user's own signature assets (upload / view / deactivate). */
export function SignatureAssetsPanel(): React.JSX.Element {
  const [assets, setAssets] = useState<SignatureAssetView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    try {
      setAssets(await signatureApi.mySignatures())
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function upload(file: File): Promise<void> {
    setError(null)
    setNotice(null)
    if (!ALLOWED_TYPES.has(file.type)) {
      setError('صيغة الملف غير مدعومة. استخدم صورة PNG أو JPEG.')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('حجم الملف يتجاوز الحد الأقصى (1 ميجابايت).')
      return
    }
    setBusy(true)
    try {
      await signatureApi.upload(file)
      setNotice('تم رفع التوقيع بنجاح.')
      await reload()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function deactivate(assetId: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await signatureApi.deactivate(assetId)
      await reload()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-label="إدارة التوقيع">
      <h2>أصول التوقيع المخزنة</h2>
      <p className="muted">
        هذه الشاشة ترفع أو تعطل صورة التوقيع المحفوظة في حسابك فقط. اعتماد الطلب يتم من مراجعة المدير
        في المراحل الرسمية P1 وP2 وP4 للترقية وS1 وS2 وS3 للندب، مع كلمة المرور الحالية في كل مرة.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}

      <label className="field">
        رفع توقيع جديد (PNG أو JPEG بحد أقصى 1 ميجابايت)
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          disabled={busy}
          onChange={event => {
            const file = event.target.files?.[0]
            if (file) void upload(file)
          }}
        />
      </label>
      <p className="hint"><Upload size={14} aria-hidden="true" /> يتم تحويل الصورة تلقائياً إلى صيغة قياسية آمنة على الخادم.</p>

      {assets === null ? (
        <p className="muted">جارٍ التحميل…</p>
      ) : assets.length === 0 ? (
        <p className="empty">لا توجد توقيعات مسجلة بعد.</p>
      ) : (
        <div className="signature-grid">
          {assets.map(asset => (
            <figure key={asset.id} className={`signature-card${asset.isActive ? '' : ' signature-card--inactive'}`}>
              <img src={signatureApi.imageUrl(asset.id)} alt={`التوقيع المسجل ${formatDate(asset.createdAt)}`} />
              <figcaption>
                <span>{formatDate(asset.createdAt)}</span>
                <span className="mono">{Math.round(asset.byteSize / 1024)} KB</span>
                <span>{asset.isActive ? 'نشط' : 'معطل'}</span>
                {asset.isActive && (
                  <button type="button" className="button button--secondary" disabled={busy} onClick={() => void deactivate(asset.id)}>
                    تعطيل
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  )
}
