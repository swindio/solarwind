import {
  CircularDeps,
  createType,
  extendDefinition,
  GraphType,
  ObjectDefinitionInput,
  ObjectType,
} from '@backland/schema';
import { isMetaFieldKey } from '@backland/schema/lib/fields/MetaFieldField';
import {
  CollectionIndexConfig,
  getDocumentIndexFields,
  getParsedIndexKeys,
  ParsedDocumentIndexes,
  ParsedIndexKey,
  Transporter,
  TransporterLoader,
  TransporterLoaderName,
  transporterLoaderNames,
  validateIndexNameAndField,
} from '@backland/transporter';
import { createProxy, ensureArray, simpleObjectClone } from '@backland/utils';
import { RuntimeError } from '@backland/utils/lib/RuntimeError';
import { devAssert } from '@backland/utils/lib/devAssert';
import { nonNullValues, notNull } from '@backland/utils/lib/invariant';
import { capitalize } from '@backland/utils/lib/stringCase';
import { AnyFunction } from '@backland/utils/lib/typeUtils';
import { hooks } from 'plugin-hooks';

import {
  graphQLFilterToTransporterFilter,
  objectToGraphQLConditionType,
} from './EntityFilterConditionType';
import {
  AnyEntityDocument,
  createEntityDefaultFields,
  Entity,
  EntityOperationInfoContext,
} from './EntityInterfaces';
import {
  _EntityGraphType,
  EntityFieldResolver,
  EntityOptions,
} from './EntityOptions';
import { createEntityPlugin, EntityHooks } from './EntityPlugin';
import { buildEntityOperationInfoContext } from './entityOperationContextTypes';
import { PageInfoType } from './paginationUtils';
import { applyFieldResolvers } from './plugins/applyFieldResolvers';

export * from './paginationUtils';

const ulidField = CircularDeps.ulid({ autoCreate: true });
const createUlid = () => ulidField.parse(undefined);

export function createEntity<
  Name extends string,
  Type extends _EntityGraphType,
  TTransport extends Transporter,
  Options extends EntityOptions<Name, Type, TTransport>
>(entityOptions: Options): Entity<Options> {
  const plugins = [applyFieldResolvers];
  const resolvers: EntityFieldResolver<any, any, any, any>[] = [];
  let gettersWereCalled = false;

  const entity = createProxy(_createEntity, {
    onGet(k): any {
      if (k === 'addHooks') {
        return function addHooks(hooks) {
          plugins.push(
            ...ensureArray(hooks).map((hookConfig, index) => {
              return createEntityPlugin(
                `${entityOptions.name}MainPlugin_${index}`,
                hookConfig
              );
            })
          );
          return entity;
        };
      }

      if (k === 'addRelations') {
        if (gettersWereCalled) {
          throw new Error(
            `addRelations should be used right after entity creation.`
          );
        }

        return function addRelations(resolver) {
          resolvers.push(...ensureArray(resolver));
          return entity;
        };
      }

      return null;
    },
  });

  function _createEntity() {
    gettersWereCalled = true;

    const {
      indexes,
      transporter: defaultTransporter,
      type,
      name: entityName,
    } = entityOptions;

    const _hooks: EntityHooks = {
      beforeQuery: hooks.waterfall(),
      createDefinition: hooks.parallel(),
      filterResult: hooks.waterfall(),
      postParse: hooks.waterfall(),
      preParse: hooks.waterfall(),
    };

    plugins.forEach((plugin) => {
      try {
        plugin(_hooks);
      } catch (e: any) {
        throw new RuntimeError(`Failed to apply plugin ${plugin?.name}`, {
          message: e.message,
          plugin,
        });
      }
    });

    const entityNameLowercase = entityName.toLowerCase();

    const inputObjectType = nonNullValues({
      entityTypeObject: type._object,
    }).entityTypeObject;

    const entity = {} as any;
    const loaders: Record<string, any> = {};

    let entityOutputDefinitionWithRelations = {
      ...createEntityDefaultFields(),
      ...inputObjectType.cleanDefinition(),
    };

    const fields = Object.keys(entityOutputDefinitionWithRelations);
    let inputDef = inputObjectType.cleanDefinition();

    let updateDefinition = inputObjectType.clone().optional().def();

    _hooks.createDefinition.exec(updateDefinition, {
      entityOptions,
      fields,
      kind: 'updateDefinition',
      resolvers,
    });

    const databaseDefinition = simpleObjectClone(
      entityOutputDefinitionWithRelations
    );
    _hooks.createDefinition.exec(databaseDefinition, {
      entityOptions,
      fields,
      kind: 'databaseDefinition',
      resolvers,
    });
    // type without relations
    const databaseType = createType(`${entityOptions.name}_withoutRelations`, {
      // without relations and other alterations
      object: databaseDefinition,
    });

    _hooks.createDefinition.exec(entityOutputDefinitionWithRelations, {
      entityOptions,
      fields,
      kind: 'outputDefinition',
      resolvers,
    });

    _hooks.createDefinition.exec(inputDef, {
      entityOptions,
      fields,
      kind: 'inputDefinition',
      resolvers,
    });

    entity['transporter'] = defaultTransporter;

    const indexConfig: CollectionIndexConfig<any, string> = {
      entity: entityNameLowercase,
      indexes,
    };

    const conditionsType = objectToGraphQLConditionType(
      `${entityName}QueryConditions`,
      entityOutputDefinitionWithRelations
    );

    validateIndexNameAndField(indexConfig);
    const parsedIndexKeys = getParsedIndexKeys(indexConfig);

    // pre parse PK, SK and ID setters
    _hooks.preParse.register(async function applyDefaultHooks(ctx) {
      async function _onUpdate(doc: Record<string, any>) {
        doc.updatedAt = new Date();
        doc.updatedBy =
          doc.updatedBy || (await ctx.options.context?.userId?.(false));
        return doc;
      }

      async function _onCreate(doc: Record<string, any>) {
        await _onUpdate(doc);
        doc.ulid = doc.ulid || createUlid();
        doc.createdAt = new Date();
        doc.createdBy =
          doc.createdBy || (await ctx.options.context?.userId?.(false));

        const parsedIndexes = getDocumentIndexFields(doc, indexConfig);

        if (!parsedIndexes.valid) {
          throw parsedIndexes.error;
        }

        doc = {
          ...parsedIndexes.indexFields,
          ...doc,
        };

        if (!doc.id) {
          doc.id = parsedIndexes.firstIndex.value;
        }

        return doc;
      }

      if (ctx.op === 'updateOne') {
        ctx.options.update.$set = await _onUpdate({
          ...ctx.options.update.$set,
        });
      }

      if (ctx.isUpsert) {
        const $setOnInsert = await _onCreate({
          ...ctx.options.update.$set,
          ...ctx.options.update.$setOnInsert,
        });
        ctx.options.update.$setOnInsert = {
          ...$setOnInsert,
        };
      }

      if (ctx.isCreate) {
        ctx.options.item = await _onCreate(ctx.options.item);
      }

      return ctx;
    });

    const entityType = createType(`${entityName}Entity`, {
      object: entityOutputDefinitionWithRelations,
    });

    async function parseOperationContext(
      method: TransporterLoaderName,
      methodOptions: any
    ): Promise<EntityOperationInfoContext> {
      await defaultTransporter?.connect();

      let operationInfoContext = buildEntityOperationInfoContext(
        method,
        methodOptions,
        entityOptions
      );

      if ('filter' in operationInfoContext.options) {
        operationInfoContext.options.filter = graphQLFilterToTransporterFilter(
          operationInfoContext.options.filter
        );
      }
      if ('condition' in operationInfoContext.options) {
        operationInfoContext.options.condition =
          graphQLFilterToTransporterFilter(
            operationInfoContext.options.condition
          );
      }

      if (operationInfoContext.op === 'updateOne') {
        operationInfoContext = await _hooks.preParse.exec(
          // @ts-ignore
          operationInfoContext,
          {}
        );
      }

      if ('item' in operationInfoContext.options) {
        operationInfoContext = await _hooks.preParse.exec(
          // @ts-ignore
          operationInfoContext,
          {}
        );

        if (!('item' in operationInfoContext.options)) {
          return devAssert('MISSING_ITEM', { operationInfoContext });
        }

        try {
          operationInfoContext.options.item = databaseType.parse(
            operationInfoContext.options.item
          ) as AnyEntityDocument;

          operationInfoContext = await _hooks.postParse.exec(
            // @ts-ignore
            operationInfoContext,
            {}
          );
        } catch (e: any) {
          e.info = operationInfoContext;
          throw e;
        }
      }

      if ('filter' in operationInfoContext.options) {
        operationInfoContext = await _hooks.beforeQuery.exec(
          // @ts-ignore
          operationInfoContext,
          {}
        );
      }

      return operationInfoContext;
    }

    const indexGraphTypes = parsedIndexKeys.reduce(
      (acc, next): Record<string, GraphType<{ object: any }>> => {
        const fields: ObjectDefinitionInput = {};

        next.PK.requiredFields.forEach((fieldName) => {
          const def = entityOutputDefinitionWithRelations[fieldName];
          if (!def) {
            throw new RuntimeError(
              `Field "${fieldName}" defined for index ${next.index.name} not defined in the input type.`,
              { type }
            );
          }
          fields[fieldName] = entityOutputDefinitionWithRelations[fieldName];
        });

        next.SK.requiredFields.forEach((fieldName) => {
          const def = entityOutputDefinitionWithRelations[fieldName];
          if (!def) {
            throw new RuntimeError(
              `Field "${fieldName}" defined for index ${next.index.name} not defined in the input type.`,
              { type }
            );
          }
          fields[fieldName] = fields[fieldName] || { ...def, optional: true };
        });

        const typeName = `${entityName}${capitalize(next.index.name)}Index`;
        return {
          ...acc,
          [next.index.name]: createType(typeName, { object: fields }),
        };
      },
      {}
    );

    function _createLoader(config: {
      indexInfo: ParsedIndexKey[];
      indexes: EntityOptions['indexes'];
      method: TransporterLoaderName;
      newMethodName: string;
    }) {
      const { indexInfo, indexes, newMethodName, method } = config;

      const loader: TransporterLoader = async function loader(...args) {
        if (args.length !== 1) {
          return devAssert(`Invalid number of arguments for ${newMethodName}`);
        }
        const { transporter = defaultTransporter } = args['0'];

        nonNullValues(
          { transporter },
          `config.transporter should be provided for "${newMethodName}" or during entity creation.`
        );

        const configInput = {
          ...args[0],
          context: args[0].context,
          indexConfig: {
            ...indexConfig,
            indexes,
          },
        };

        const operation = await parseOperationContext(method, configInput);
        const context = { operation, resolvers };

        const resolver: AnyFunction = transporter[method].bind(transporter);
        let result = await resolver(operation.options);

        if (result.item) {
          const res = await _hooks.filterResult.exec(
            { items: [result.item], kind: 'items' },
            context
          );
          if (res.kind === 'items') result.item = res.items[0];
        }

        if (result.items) {
          const res = await _hooks.filterResult.exec(
            { items: result.items, kind: 'items' },
            context
          );
          if (res.kind === 'items') result.items = res.items;
        }

        if (result.edges) {
          const res = await _hooks.filterResult.exec(
            { kind: 'pagination', pagination: result },
            context
          );
          if (res.kind === 'pagination') result = res.pagination;
        }

        return result;
      };

      // create the filter with the index fields plus the "id" field
      function getFilterDef() {
        function _addIDField(obj: object) {
          const def: any = { id: { optional: true, type: 'ID' } };

          Object.keys(obj).forEach((k) => {
            if (isMetaFieldKey(k)) return;
            def[k] = { ...obj[k], optional: true };
          });

          return def;
        }

        if (indexInfo.length === 1) {
          const obj = {
            ...indexGraphTypes[
              indexInfo[0].index.name
            ]._object!.cleanDefinition(),
          };
          return _addIDField(obj);
        }

        const all: any = {};

        indexInfo.forEach(({ index: { name } }) => {
          const objectType = indexGraphTypes[name]._object as ObjectType<{
            a: 'any';
          }>;

          const graph = objectType.cleanDefinition();
          Object.entries(graph).forEach(([k, v]) => {
            all[k] = {
              ...v,
              optional: true,
            };
          });
        });
        return _addIDField(all);
      }

      function getPaginationType() {
        const filter = getFilterDef();
        return {
          after: {
            optional: true,
            type: 'ID',
          },
          condition: {
            optional: true,
            type: conditionsType,
          },
          filter: {
            def: filter,

            type: 'object',
          },
          first: {
            optional: true,
            type: 'int',
          },
        };
      }

      Object.defineProperties(loader, {
        filterDef: {
          get() {
            return getFilterDef();
          },
        },
        indexInfo: { value: indexInfo },
        name: { value: newMethodName },
        queryArgs: {
          get() {
            return getPaginationType();
          },
        },
      });

      loaders[newMethodName] = loader;
      entity[newMethodName] = loader;
    }

    indexConfig.indexes.forEach((index) => {
      const { name: indexName } = index;
      const indexInfo = notNull(
        parsedIndexKeys.find((el) => el.index.name === indexName)
      );

      const capitalizedIndexName = capitalize(indexName);

      transporterLoaderNames.forEach((method) => {
        if (method === 'createOne') return;
        const methodName = `${method}${capitalizedIndexName}`;
        _createLoader({
          indexInfo: [indexInfo],
          indexes: [
            indexConfig.indexes.find((index) => index.name === indexName)!,
          ],
          method,
          newMethodName: methodName,
        });
      });
    });

    transporterLoaderNames.forEach((method) => {
      _createLoader({
        indexInfo: parsedIndexKeys,
        indexes: indexConfig.indexes,
        method,
        newMethodName: method,
      });
    });

    const edgeType = createType(`${entityName}_Edge`, {
      object: {
        cursor: 'string',
        node: entityType,
      },
    });

    function getPaginationType() {
      const definition = {
        object: {
          edges: {
            list: true,
            type: edgeType,
          },
          pageInfo: PageInfoType,
        },
      } as const;

      return createType(`${entityName}Connection`, definition);
    }

    const ext_utils = { extend: extendDefinition };

    function extend(cb) {
      const partial = cb(entity, ext_utils);
      if (!partial || typeof partial !== 'object') return entity;
      const res: any = { ...entity };
      Object.entries(partial).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
          res[k] = v;
        }
      });
      return res;
    }

    function getDocumentId(doc): string {
      const indexes = getDocumentIndexFields(doc, indexConfig);
      if (indexes.error) throw indexes.error;
      return notNull(indexes.indexFields.id);
    }

    type TEntity = any; // FIXME_EntityMethods<Options> & { loaders: Record<string, any> };

    // @ts-ignore
    const getters: {
      [K in keyof TEntity]: any;
    } = {
      addHooks: () => ({}), // handled in proxy
      addRelations: () => ({}), // handled in proxy
      conditionsDefinition: conditionsType._object!.definition,
      edgeType: edgeType,
      extend,
      getDocumentId,
      indexGraphTypes: indexGraphTypes,
      indexes: indexes,
      inputDefinition: inputDef,
      loaders: loaders,
      name: entityName,
      originType: type,
      paginationType: getPaginationType(),
      parse: entityType.parse,
      parseDocumentIndexes: function parseDocumentIndexes(
        doc
      ): ParsedDocumentIndexes {
        return getDocumentIndexFields(doc, indexConfig);
      },
      transporter: defaultTransporter || entityOptions.transporter,
      type: entityType,
      updateDefinition: updateDefinition,
    };

    Object.assign(entity, getters);

    return entity;
  }

  return entity;
}