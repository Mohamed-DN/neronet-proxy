const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const logger = require('../utils/logger');

const SCHEMA_DIR =
  process.env.SOVEREIGN_CONTRACT_SCHEMA_DIR ||
  path.resolve(__dirname, '../../../api/contract/v4');

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false
});
addFormats(ajv);

const validators = new Map();

function initContractSchemas() {
  if (!fs.existsSync(SCHEMA_DIR)) {
    logger.warn(`[CONTRACT] Schema directory not found: ${SCHEMA_DIR}`);
    return;
  }

  const files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'));

  // First pass: add schemas to Ajv so cross-references ($defs, $id) resolve
  const loaded = [];
  for (const file of files) {
    const filePath = path.join(SCHEMA_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const schema = JSON.parse(raw);
    const baseName = file.replace('.schema.json', '');
    try {
      ajv.addSchema(schema, baseName);
      loaded.push({ baseName, schema });
    } catch (err) {
      logger.error(`[CONTRACT] Failed adding schema ${file}: ${err.message}`);
      throw err;
    }
  }

  // Second pass: compile and store validators under PascalCase and dot-case names
  for (const { baseName, schema } of loaded) {
    try {
      const validate = ajv.compile(schema);
      validators.set(baseName, validate);

      // Also register friendly aliases, e.g. RegisterRequest -> register.request
      const dotName = baseName
        .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
        .toLowerCase();
      validators.set(dotName, validate);
    } catch (err) {
      logger.error(`[CONTRACT] Failed compiling schema ${baseName}: ${err.message}`);
      throw err;
    }
  }

  logger.info(`[CONTRACT] Compiled ${loaded.length} contract schemas from ${SCHEMA_DIR}`);
}

initContractSchemas();

function extractJsonPointer(err) {
  if (!err) return '/';
  if (err.keyword === 'required' && err.params && err.params.missingProperty) {
    return err.instancePath
      ? `${err.instancePath}/${err.params.missingProperty}`
      : `/${err.params.missingProperty}`;
  }
  if (err.keyword === 'additionalProperties' && err.params && err.params.additionalProperty) {
    return err.instancePath
      ? `${err.instancePath}/${err.params.additionalProperty}`
      : `/${err.params.additionalProperty}`;
  }
  return err.instancePath || '/';
}

function validateRequest(schemaName) {
  return function contractValidationMiddleware(req, res, next) {
    const validate = validators.get(schemaName);
    if (!validate) {
      logger.error(`[CONTRACT] Schema validator not found: ${schemaName}`);
      return res.status(500).json({ error: `schema validator not found: ${schemaName}` });
    }

    const data = req.body || {};
    const valid = validate(data);

    if (!valid) {
      const firstErr = validate.errors[0];
      const pointer = extractJsonPointer(firstErr);
      const errorMsg = `contract validation failed: ${pointer} ${firstErr.message}`;

      logger.warn(`[CONTRACT] 400 Bad Request on ${req.originalUrl}: ${errorMsg}`);

      return res.status(400).json({
        error: errorMsg,
        pointer: pointer,
        message: firstErr.message,
        errors: validate.errors.map((e) => ({
          pointer: extractJsonPointer(e),
          keyword: e.keyword,
          message: e.message,
          params: e.params
        }))
      });
    }

    next();
  };
}

function validateResponse(schemaName, data) {
  const validate = validators.get(schemaName);
  if (!validate) {
    throw new Error(`Schema validator not found: ${schemaName}`);
  }
  const valid = validate(data);
  return {
    valid: Boolean(valid),
    errors: validate.errors || [],
    pointer: validate.errors && validate.errors.length > 0 ? extractJsonPointer(validate.errors[0]) : null,
    message: validate.errors && validate.errors.length > 0 ? validate.errors[0].message : null
  };
}

function responseValidationInterceptor(routeSchemaMap) {
  return function (req, res, next) {
    if (process.env.SOVEREIGN_VALIDATE_RESPONSES !== 'true') {
      return next();
    }

    const expectedSchema = routeSchemaMap[req.path];
    if (!expectedSchema) {
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const check = validateResponse(expectedSchema, body);
        if (!check.valid) {
          const msg = `Response from ${req.path} failed ${expectedSchema} schema at ${check.pointer}: ${check.message}`;
          logger.error(`[CONTRACT] ${msg}`);
          throw new Error(msg);
        }
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = {
  validateRequest,
  validateResponse,
  responseValidationInterceptor,
  initContractSchemas,
  extractJsonPointer,
  validators,
  ajv
};
