import z from "@deepseek-ai/schemastery";
const s = z.object({ a: z.boolean().default(true), b: z.union(["auto","ocr"]).default("auto") });
const marked = z.object({ c: z.string().default("x").volatile() });
const parsed = marked({});
const v = parsed.c;
console.log("volatile-fn=", typeof s.volatile, "| parsed-c-get=", typeof (v && v.get), "| get()=", v && v.get ? v.get() : v);
console.log("union-ok=", JSON.stringify(s({ b: "ocr" }).b), "| bad=", (()=>{ try { s({b:"zzz"}); return "no-throw"; } catch(e){ return "throws"; } })());
