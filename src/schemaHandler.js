"use strict";

const isEqual = require("node:util").isDeepStrictEqual;
const path = require("path");

const $RefParser = require("@apidevtools/json-schema-ref-parser");
const SchemaConvertor = require("json-schema-for-openapi");
const { v4: uuid } = require("uuid");

class SchemaHandler {
  constructor(serverless, openAPI, logger) {
    this.logger = logger;

    this.apiGatewayModels =
      serverless.service?.provider?.apiGateway?.request?.schemas || {};
    this.documentation = serverless.service.custom.documentation;
    this.openAPI = openAPI;

    this.modelReferences = {};

    this.__standardiseModels();

    try {
      this.logger.verbose(
        `Trying to resolve Ref-Parser config from: ${path.resolve(
          "options",
          "ref-parser.js"
        )}`
      );
      this.refParserOptions = require(path.resolve("options", "ref-parser.js"));
    } catch (err) {
      this.refParserOptions = {};
    }
  }

  /**
   * Standardises the models to a specific format
   */
  __standardiseModels() {
    const standardModel = (model) => {
      if (model.schema) {
        return model;
      }

      const contentType = Object.keys(model.content)[0];
      model.contentType = contentType;
      model.schema = model.content[contentType].schema;

      return model;
    };

    const standardisedModels =
      this.documentation?.models?.map(standardModel) || [];
    const standardisedModelsList =
      this.documentation?.modelsList?.map(standardModel) || [];

    const standardisedGatewayModels =
      Object.keys(this.apiGatewayModels).flatMap((key) => {
        const gatewayModel = this.apiGatewayModels[key];
        return standardModel(gatewayModel);
      }) || [];

    this.models = standardisedModels.concat(
      standardisedModelsList,
      standardisedGatewayModels
    );
  }

  async addModelsToOpenAPI() {
    for (const model of this.models) {
      const modelName = model.name;
      const modelSchema = model.schema;

      const convertedSchemas = await this.__dereferenceAndConvert(
        modelSchema,
        modelName,
        model
      ).catch((err) => {
        if (err instanceof Error) throw err;
        else return err;
      });

      if (
        typeof convertedSchemas.schemas === "object" &&
        !Array.isArray(convertedSchemas.schemas) &&
        convertedSchemas.schemas !== null
      ) {
        for (const [schemaName, schemaValue] of Object.entries(
          convertedSchemas.schemas
        )) {
          if (schemaName === modelName) {
            this.modelReferences[
              schemaName
            ] = `#/components/schemas/${modelName}`;
          }

          this.__addToComponents("schemas", schemaValue, schemaName);
        }
      } else {
        throw new Error(
          `There was an error converting the ${
            model.name
          } schema. Model received looks like: \n\n${JSON.stringify(
            model
          )}.  The convereted schema looks like \n\n${JSON.stringify(
            convertedSchemas
          )}`
        );
      }
    }
  }

  async createSchema(name, schema) {
    let originalName = name;
    let finalName = name;

    if (this.modelReferences[name] && schema === undefined) {
      return this.modelReferences[name];
    }

    const convertedSchemas = await this.__dereferenceAndConvert(schema, name, {
      name,
      schema,
    }).catch((err) => {
      throw err;
    });

    for (const [schemaName, schemaValue] of Object.entries(
      convertedSchemas.schemas
    )) {
      if (this.__existsInComponents(schemaName)) {
        if (this.__isTheSameSchema(schemaValue, schemaName) === false) {
          if (schemaName === originalName) {
            finalName = `${schemaName}-${uuid()}`;
            this.__addToComponents("schemas", schemaValue, finalName);
          } else {
            this.__addToComponents("schemas", schemaValue, schemaName);
          }
        }
      } else {
        this.__addToComponents("schemas", schemaValue, schemaName);
      }
    }

    return `#/components/schemas/${finalName}`;
  }

  async __dereferenceAndConvert(schema, name, model) {
    this.logger.verbose(`dereferencing model: ${name}`);
    const dereferencedSchema = await this.__dereferenceSchema(schema).catch(
      (err) => {
        this.__checkForHTTPErrorsAndThrow(err, model);

        this.__checkForMissingPathAndThrow(err);

        return schema;
      }
    );

    this.logger.verbose(
      `dereferenced model: ${JSON.stringify(dereferencedSchema)}`
    );

    this.logger.verbose(`converting model: ${name}`);
    const convertedSchemas = SchemaConvertor.convert(dereferencedSchema, name);

    // Custom code
    for (const [key, value] of Object.entries(model)) {
      if (key.startsWith("x-") && convertedSchemas.schemas?.[name]) {
        convertedSchemas.schemas[name][key] = value;
      }
    }

    this.logger.verbose(
      `converted schemas: ${JSON.stringify(convertedSchemas)}`
    );

    return convertedSchemas;
  }

  async __dereferenceSchema(schema) {
    const bundledSchema = await $RefParser
      .bundle(schema, this.refParserOptions)
      .catch((err) => {
        throw err;
      });

    let deReferencedSchema = await $RefParser
      .dereference(bundledSchema, this.refParserOptions)
      .catch((err) => {
        throw err;
      });

    // deal with schemas that have been de-referenced poorly: naive
    if (deReferencedSchema?.$ref === "#") {
      const oldRef = bundledSchema.$ref;
      const path = oldRef.split("/");

      const pathTitle = path[path.length - 1];
      const referencedProperties = deReferencedSchema.definitions[pathTitle];

      Object.assign(deReferencedSchema, { ...referencedProperties });

      delete deReferencedSchema.$ref;
      deReferencedSchema = await this.__dereferenceSchema(
        deReferencedSchema
      ).catch((err) => {
        throw err;
      });
    }

    return deReferencedSchema;
  }

  /**
   * @function existsInComponents
   * @param {string} name - The name of the Schema
   * @returns {boolean} Whether it exists in components already
   */
  __existsInComponents(name) {
    return Boolean(this.openAPI?.components?.schemas?.[name]);
  }

  /**
   * @function isTheSameSchema
   * @param {object} schema - The schema value
   * @param {string} otherSchemaName - The name of the schema
   * @returns {boolean} Whether the schema provided is the same one as in components already
   */
  __isTheSameSchema(schema, otherSchemaName) {
    return isEqual(schema, this.openAPI.components.schemas[otherSchemaName]);
  }

  /**
   * @function addToComponents
   * @param {string} type - The component type
   * @param {object} schema - The schema
   * @param {string} name - The name of the schema
   */
  __addToComponents(type, schema, name) {
    const schemaObj = {
      [name]: schema,
    };

    if (this.openAPI?.components) {
      if (this.openAPI.components[type]) {
        Object.assign(this.openAPI.components[type], schemaObj);
      } else {
        Object.assign(this.openAPI.components, { [type]: schemaObj });
      }
    } else {
      const components = {
        components: {
          [type]: schemaObj,
        },
      };

      Object.assign(this.openAPI, components);
    }
  }

  __checkForMissingPathAndThrow(error) {
    if (error.message === "Expected a file path, URL, or object. Got undefined")
      throw error;
  }

  __checkForHTTPErrorsAndThrow(error, model) {
    if (error.errors) {
      for (const err of error?.errors) {
        this.__HTTPError(err, model);
      }
    } else {
      this.__HTTPError(error, model);
    }
  }

  __HTTPError(error, model) {
    if (error.message.includes("HTTP ERROR")) {
      throw new Error(
        `There was an error dereferencing ${
          model.name
        } schema.  \n\n dereferencing message: ${
          error.message
        } \n\n Model received: ${JSON.stringify(model)}`
      );
    }
  }
}

module.exports = SchemaHandler;
