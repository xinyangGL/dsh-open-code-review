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
