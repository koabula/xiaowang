import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import type { Attachment } from "../../src/types.ts";

export function AttachmentChip({ slug, attachment, onRemove, onOpen }: { slug: string; attachment: Attachment; onRemove?: () => void; onOpen?: () => void }) {
  const [image, setImage] = useState("");
  useEffect(() => {
    if (!attachment.mimeType.startsWith("image/")) return;
    let disposed = false, url = "";
    void window.xiaowang.readFile(slug, attachment.refId).then(bytes => {
      if (disposed) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: attachment.mimeType })); setImage(url);
    }).catch(() => {});
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [slug, attachment.refId, attachment.mimeType]);
  const isImage = attachment.mimeType.startsWith("image/");
  return <div className={`attachment-chip${isImage ? " image-attachment" : " file-attachment"}${onRemove ? " draft-attachment" : " sent-attachment"}`}>
    <button className="attachment-open" type="button" onClick={onOpen} disabled={!onOpen} title={attachment.filename}>
      {isImage && image ? <img src={image} alt={attachment.filename} /> : <FileText size={18} />}
      {!isImage ? <span>{attachment.filename}<small>{attachment.byteSize < 1024 ? `${attachment.byteSize} B` : `${Math.ceil(attachment.byteSize / 1024)} KB`}</small></span> : null}
    </button>
    {onRemove ? <button className="icon attachment-remove" type="button" aria-label={`移除 ${attachment.filename}`} onClick={onRemove}><X size={13} /></button> : null}
  </div>;
}
