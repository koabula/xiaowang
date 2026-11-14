import { useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export function RichText({ text, slug }: { text: string; slug: string }) {
  const [error, setError] = useState("");
  async function open(href: string) {
    setError("");
    try {
      if (href.startsWith("xwref://")) {
        const url = new URL(href);
        await window.xiaowang.openReference(slug, url.hostname, Number(url.searchParams.get("page") || 1));
      } else await window.xiaowang.openLink(href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <><Markdown remarkPlugins={[remarkGfm]} urlTransform={url => url.startsWith("xwref://") ? url : defaultUrlTransform(url)} components={{ a({ href, children }) { return <a href={href} onClick={event => { if (href) { event.preventDefault(); void open(href); } }}>{children}</a>; } }}>{text}</Markdown>{error ? <p role="alert" className="reader-error">{error}</p> : null}</>;
}
