import z from "@deepseek-ai/schemastery";
const probes = {
  description: typeof z.string().description,
  comment: typeof z.string().comment,
  role: typeof z.string().role,
  min: typeof z.number().min,
  max: typeof z.number().max,
  arr: typeof z.array,
  dict: typeof z.dict,
  volatile: typeof z.boolean().default(true).volatile,
};
console.log(JSON.stringify(probes));
const S = z.object({
  a: z.boolean().default(true).description("开关").volatile(),
  b: z.union(["auto","ocr","delegate"]).default("auto").description("引擎").volatile(),
  c: z.string().role("credential-ref").default("COMMANDCODE_API_KEY").description("凭据").volatile(),
  d: z.number().min(1).max(120).default(15).description("超时").volatile(),
});
const parsed = S({});
const out = {};
for (const [k, v] of Object.entries(parsed)) out[k] = (v && typeof v.get === "function") ? v.get() : v;
console.log("parsed=", JSON.stringify(out));
console.log("meta-sample=", JSON.stringify(S.dict?.a?.meta ?? S.meta ?? null).slice(0, 200));
