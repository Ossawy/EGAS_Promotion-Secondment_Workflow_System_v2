export type UserSignatureAsset = {
  id: string
  userId: string
  storageKey: string
  mimeType: string
  byteSize: number
  sha256: string
  isActive: boolean
  createdAt: string
}

export type SignatureAssetView = {
  id: string
  mimeType: string
  byteSize: number
  sha256: string
  isActive: boolean
  createdAt: string
}

export type SignatureCanonicalResult = {
  buffer: Buffer
  width: number
  height: number
  sha256: string
  byteSize: number
}
