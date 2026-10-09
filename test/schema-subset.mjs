/**
 * DSH tool schema 子集的校验器（移植自 app.asar 里 `@deepseek-ai/dsh-tools/lib/index.js`
 * 的 `checkSchemaNode` / `assertSupportedJsonSchema` 与 `CONSTRAINT_KEYWORDS` /
 * `ANNOTATION_KEYWORDS` / `SCHEMA_TYPES` / `ONE_OF_SIBLING_KEYWORDS` 常量）。
 *
 * 为什么要有这一份：宿主在 `ctx.tools.register()` 时会用同一套规则检查 `output.schema`，
 * 一旦违反就抛 `JsonSchemaError`，**让整个插件的 host fiber 加载失败**（工具、命令全部消失）。
 * 而测试里的假 `ctx.tools.register` 不校验 —— 于是「type 数组」这种写法能让六套单测全绿，
 * 却只有真人重启 DSH 才会炸。把它搬进测试，重启前就能拦住。
 *
 * 规则（照抄宿主实现，不要随手放宽）：
 * - 只认这些关键字：type / oneOf / properties / required / additionalProperties / items /
 *   enum / const + 注解 description / title / default / examples；其它一律违规。
 * - `type` 必须是**单个**字符串，取值 object/array/string/number/integer/boolean/null。
 * - 一个节点不能同时声明 `type` 与 `oneOf`；`oneOf` 必须 ≥2 个分支。
 * - properties/required/additionalProperties 只能挂在 `type:"object"` 上，items 只能挂 array，
 *   enum/const 只能用于标量（含 null）。
 * - `required` 里的名字必须在 `properties` 里；`additionalProperties` 只接受布尔。
 *
 * 另外两条同类教训（都在本文件里立了断言）：
 * - **调用期**宿主还会拿 `output.schema` 校验 execute 的返回值，多一个字段就报
 *   `returned invalid output: "value.aborted" is not a declared property`（见 payloadViolations）。
 * - 校验之前先有一步 `snapshotJsonValue`：返回值里任何一层出现 `undefined`/`NaN`/`-0`/
 *   稀疏数组/类实例，宿主直接报 `value is not lossless JSON`（见 losslessViolations）。
 */

export const CONSTRAINT_KEYWORDS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
]);

export const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);

export const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

/** 与 oneOf 并列就会违规的关键字。 */
export const ONE_OF_SIBLING_KEYWORDS = ["properties", "required", "additionalProperties", "items", "enum", "const"];

const KEYWORD_TYPES = {
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  items: ["array"],
  enum: ["string", "number", "integer", "boolean", "null"],
  const: ["string", "number", "integer", "boolean", "null"],
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** 标量是否匹配某个声明类型（宿主同款）。 */
function scalarMatches(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return isJsonNumber(value);
    case "integer":
      return isJsonNumber(value) && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/**
 * 收集一棵 schema 树上的全部违规（空数组 = 宿主会接受）。
 * @param {unknown} schema 待检查的 schema。
 * @param {string} [rootPath] 报错前缀，便于定位（默认 `schema`）。
 * @returns {string[]} 违规说明。
 */
export function schemaViolations(schema, rootPath = "schema") {
  const violations = [];
  const seen = new Set();

  const walk = (node, path) => {
    if (!isRecord(node)) {
      violations.push(`${path} must be a schema object`);
      return;
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`);
      return;
    }
    seen.add(node);
    try {
      for (const key of Object.keys(node)) {
        if (CONSTRAINT_KEYWORDS.has(key)) continue;
        if (ANNOTATION_KEYWORDS.has(key)) {
          if (key === "description" || key === "title") {
            if (typeof node[key] !== "string") violations.push(`${path}.${key} must be a string`);
          }
          continue;
        }
        violations.push(
          `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
        );
      }

      const hasType = Object.hasOwn(node, "type");
      const hasOneOf = Object.hasOwn(node, "oneOf");
      if (hasType && hasOneOf) {
        violations.push(`${path} cannot declare both type and oneOf`);
        return;
      }
      if (!hasType && !hasOneOf) {
        for (const key of ONE_OF_SIBLING_KEYWORDS) {
          if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
        }
        return;
      }

      if (hasOneOf) {
        for (const key of ONE_OF_SIBLING_KEYWORDS) {
          if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
        }
        const oneOf = node.oneOf;
        if (!Array.isArray(oneOf) || oneOf.length < 2) {
          violations.push(`${path}.oneOf must be an array of at least two schemas`);
          return;
        }
        oneOf.forEach((entry, index) => walk(entry, `${path}.oneOf[${index}]`));
        return;
      }

      const type = node.type;
      if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
        violations.push(
          Array.isArray(type)
            ? `${path}.type must be a single type string (type arrays are not supported)`
            : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`,
        );
        return;
      }

      for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
        if (Object.hasOwn(node, key) && !types.includes(type)) {
          violations.push(`${path}.${key} is not supported on type "${type}"`);
        }
      }

      if (type === "object") {
        const properties = Object.hasOwn(node, "properties") ? node.properties : undefined;
        if (Object.hasOwn(node, "properties")) {
          if (!isRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
          else for (const [name, entry] of Object.entries(properties)) walk(entry, `${path}.properties.${name}`);
        }
        if (Object.hasOwn(node, "required")) {
          const required = node.required;
          if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) {
            violations.push(`${path}.required must be an array of strings`);
          } else {
            const declared = isRecord(properties) ? properties : {};
            for (const key of required) {
              if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
            }
          }
        }
        if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") {
          violations.push(`${path}.additionalProperties must be a boolean`);
        }
        return;
      }

      if (type === "array") {
        if (Object.hasOwn(node, "items")) walk(node.items, `${path}.items`);
        return;
      }

      // 标量（含 null）：enum / const 的取值也要对得上类型。
      const hasEnum = Object.hasOwn(node, "enum");
      const allowed = hasEnum ? node.enum : undefined;
      const enumValid = Array.isArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(type, entry));
      if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${type} values`);
      if (Object.hasOwn(node, "const")) {
        const constValid = scalarMatches(type, node.const);
        if (!constValid) violations.push(`${path}.const must be a ${type} value`);
        else if (enumValid && !allowed.includes(node.const)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
      }
    } finally {
      seen.delete(node);
    }
  };

  walk(schema, rootPath);
  return violations;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  const left = Object.keys(a);
  const right = Object.keys(b);
  return left.length === right.length && left.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** 递归比对「值」与「schema」，把不符之处写进 out。 */
function collectPayloadViolations(schema, value, path, out) {
  if (!isRecord(schema)) return;
  if (Object.hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
    out.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    out.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const buckets = schema.oneOf.map((branch) => {
      const bucket = [];
      collectPayloadViolations(branch, value, path, bucket);
      return bucket;
    });
    if (!buckets.some((bucket) => bucket.length === 0)) {
      out.push(`${path} matches no oneOf branch (${buckets.map((bucket) => bucket[0]).join(" / ")})`);
    }
    return;
  }
  if (value === undefined) return;
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) {
      out.push(`${path} must be an object`);
      return;
    }
    const declared = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) out.push(`${path}.${key} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(declared, key)) {
        collectPayloadViolations(declared[key], entry, `${path}.${key}`, out);
        continue;
      }
      // 宿主原文：`"value.aborted" is not a declared property (additionalProperties: false)`。
      if (schema.additionalProperties === false) out.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      out.push(`${path} must be an array`);
      return;
    }
    if (isRecord(schema.items)) {
      value.forEach((entry, index) => collectPayloadViolations(schema.items, entry, `${path}[${index}]`, out));
    }
    return;
  }
  if (typeof type === "string" && !scalarMatches(type, value)) {
    out.push(`${path} must be a ${type}, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
}

/**
 * 收集「返回值」与 schema 的不符之处（空数组 = 宿主会接受）。
 *
 * 宿主不只在 register 时检查 schema，**调用期还会用 output.schema 校验 execute 的返回值**：
 * 顶层 `additionalProperties: false` 时多一个字段（例如 `aborted`）就会报
 * `tool "ocr_review" returned invalid output: "value.aborted" is not a declared property`。
 * @param {unknown} schema 工具的 output.schema。
 * @param {unknown} value execute 的返回值。
 * @param {string} [rootPath] 报错前缀（宿主叫 `value`，默认一致）。
 * @returns {string[]} 违规说明。
 */
export function payloadViolations(schema, value, rootPath = "value") {
  const out = [];
  collectPayloadViolations(schema, value, rootPath, out);
  return out;
}

/** 返回值不符就抛。 */
export function assertToolPayload(label, schema, value) {
  const problems = payloadViolations(schema, value, `${label}.value`);
  if (problems.length > 0) {
    throw new Error(`tool 返回值不符合 output.schema（宿主会拒收）：\n  - ${problems.join("\n  - ")}`);
  }
}

/** 递归比对「值」与宿主 snapshotJsonValue 的无损 JSON 规则，把不符之处写进 out。 */
function collectLossless(value, path, out) {
  if (value === undefined) {
    out.push(`${path} 是 undefined：宿主会把整份返回值快照成 undefined（ToolOutputError: value is not lossless JSON）`);
    return;
  }
  const kind = typeof value;
  if (kind === "number") {
    if (!Number.isFinite(value)) out.push(`${path} 不是有限数字（${String(value)}）`);
    else if (Object.is(value, -0)) out.push(`${path} 是 -0：dsh-util-values 明确拒收`);
    return;
  }
  if (kind === "string" || kind === "boolean" || value === null) return;
  if (kind !== "object") {
    out.push(`${path} 的类型是 ${kind}，不是 JSON 值`);
    return;
  }
  if (Array.isArray(value)) {
    // 宿主：数组必须 plain，且 Reflect.ownKeys(current).length === length + 1（不许稀疏、不许挂额外属性）。
    const own = Reflect.ownKeys(value).length;
    if (own !== value.length + 1) out.push(`${path} 是稀疏数组或带额外属性（ownKeys=${own}，length=${value.length}）`);
    value.forEach((entry, index) => collectLossless(entry, `${path}[${index}]`, out));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    out.push(`${path} 不是 plain object（prototype=${proto?.constructor?.name ?? "null"}）`);
  }
  for (const key of Object.keys(value)) collectLossless(value[key], `${path}.${key}`, out);
}

/**
 * 收集「返回值」与无损 JSON 规则的不符之处（空数组 = 宿主能快照成功）。
 *
 * 宿主调用 execute 之后是三步：`snapshotToolValue`（= `snapshotJsonValue`）→
 * `validateJsonSchemaValue(output.schema, detached, "value")` → `deepFreeze`。
 * 第一步最容易被忽略：任何一层出现 `undefined`、`NaN`、`-0`、稀疏数组或类实例，
 * 宿主直接报 `value is not lossless JSON`，连 schema 都走不到。
 */
export function losslessViolations(value, rootPath = "value") {
  const out = [];
  collectLossless(value, rootPath, out);
  return out;
}

/** 宿主 `snapshotJsonValue` 的等价物：不合规则返回 undefined。 */
export function snapshotJsonValue(value) {
  return losslessViolations(value).length === 0 ? value : undefined;
}

/** 返回值不是无损 JSON 就抛。 */
export function assertLosslessJson(label, value) {
  const problems = losslessViolations(value, `${label}.value`);
  if (problems.length > 0) {
    throw new Error(`tool 返回值不是无损 JSON（宿主会报 "value is not lossless JSON"）：\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * 宿主对一次工具调用的完整门（等价于 dsh-tools/lib/index.js:3541-3571 的三步）：
 * ①注册期 schema 必须属于支持的子集；②返回值必须无损；③返回值必须过 output.schema。
 */
export function assertToolContract(label, definition, value) {
  assertToolSchemas(label, definition);
  assertLosslessJson(label, value);
  const schema = definition && definition.output ? definition.output.schema : undefined;
  if (schema !== undefined) assertToolPayload(label, schema, value);
}

/** 违规就抛，信息里带上工具名与路径，方便定位。 */
export function assertToolSchemas(label, definition) {
  if (definition === null || definition === undefined || typeof definition !== "object") return;
  const problems = [];
  if (Object.hasOwn(definition, "parameters")) {
    problems.push(...schemaViolations(definition.parameters, `${label}.parameters`));
  }
  if (definition.output && Object.hasOwn(definition.output, "schema")) {
    problems.push(...schemaViolations(definition.output.schema, `${label}.output.schema`));
  }
  if (problems.length > 0) {
    throw new Error(`tool schema 不属于 DSH 支持的子集（宿主 register 会抛 JsonSchemaError）：\n  - ${problems.join("\n  - ")}`);
  }
}
