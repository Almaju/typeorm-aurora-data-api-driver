/*
 * This module provides a simplified interface into the Aurora Serverless
 * Data API by abstracting away the notion of field values.
 *
 * More detail regarding the Aurora Serverless Data APIcan be found here:
 * https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html
 *
 * @author Jeremy Daly <jeremy@jeremydaly.com>
 * @version 1.2.0
 * @license MIT
 */

import { RDSData } from "@aws-sdk/client-rds-data";

// Require sqlstring to add additional escaping capabilities
import sqlString from "sqlstring";

// Supported value types in the Data API
const supportedTypes = [
  "arrayValue",
  "blobValue",
  "booleanValue",
  "doubleValue",
  "isNull",
  "longValue",
  "stringValue",
  "structValue",
];

/********************************************************************/
/**  PRIVATE METHODS                                               **/
/********************************************************************/

// Simple error function
const error = (...err: string[]) => {
  throw Error(...err);
};

// Parse SQL statement from provided arguments
const parseSQL = (args: any): string =>
  typeof args[0] === "string"
    ? args[0]
    : typeof args[0] === "object" && typeof args[0].sql === "string"
    ? args[0].sql
    : error("No 'sql' statement provided.");

// Parse the parameters from provided arguments
const parseParams = (args: any) =>
  Array.isArray(args[0].parameters)
    ? args[0].parameters
    : typeof args[0].parameters === "object"
    ? [args[0].parameters]
    : Array.isArray(args[1])
    ? args[1]
    : typeof args[1] === "object"
    ? [args[1]]
    : args[0].parameters
    ? error("'parameters' must be an object or array")
    : args[1]
    ? error("Parameters must be an object or array")
    : [];

// Parse the supplied database, or default to config
const parseDatabase = (config: any, args: any) =>
  config.transactionId
    ? config.database
    : typeof args[0].database === "string"
    ? args[0].database
    : args[0].database
    ? error("'database' must be a string.")
    : config.database
    ? config.database
    : undefined; // removed for #47 - error('No \'database\' provided.')

// Parse the supplied hydrateColumnNames command, or default to config
const parseHydrate = (config: any, args: any) =>
  typeof args[0].hydrateColumnNames === "boolean"
    ? args[0].hydrateColumnNames
    : args[0].hydrateColumnNames
    ? error("'hydrateColumnNames' must be a boolean.")
    : config.hydrateColumnNames;

// Parse the supplied format options, or default to config
const parseFormatOptions = (config: any, args: any) =>
  typeof args[0].formatOptions === "object"
    ? {
        deserializeDate:
          typeof args[0].formatOptions.deserializeDate === "boolean"
            ? args[0].formatOptions.deserializeDate
            : args[0].formatOptions.deserializeDate
            ? error("'formatOptions.deserializeDate' must be a boolean.")
            : config.formatOptions.deserializeDate,
        treatAsLocalDate:
          typeof args[0].formatOptions.treatAsLocalDate == "boolean"
            ? args[0].formatOptions.treatAsLocalDate
            : args[0].formatOptions.treatAsLocalDate
            ? error("'formatOptions.treatAsLocalDate' must be a boolean.")
            : config.formatOptions.treatAsLocalDate,
      }
    : args[0].formatOptions
    ? error("'formatOptions' must be an object.")
    : config.formatOptions;

// Prepare method params w/ supplied inputs if an object is passed
const prepareParams = ({ secretArn, resourceArn }: any, args: any) => {
  return Object.assign(
    { secretArn, resourceArn }, // return Arns
    typeof args[0] === "object" ? omit(args[0], ["hydrateColumnNames", "parameters"]) : {} // merge any inputs
  );
};

// Utility function for removing certain keys from an object
const omit = (obj: any, values: any) =>
  Object.keys(obj).reduce(
    (acc, x) => (values.includes(x) ? acc : Object.assign(acc, { [x]: obj[x] })),
    {}
  );

// Utility function for picking certain keys from an object
const pick = (obj: any, values: any) =>
  Object.keys(obj).reduce(
    (acc, x) => (values.includes(x) ? Object.assign(acc, { [x]: obj[x] }) : acc),
    {}
  );

// Utility function for flattening arrays
const flatten = (arr: any) => arr.reduce((acc: any, x: any) => acc.concat(x), []);

// Normize parameters so that they are all in standard format
const normalizeParams = (params: any) =>
  params.reduce(
    (acc: any, p: any) =>
      Array.isArray(p)
        ? acc.concat([normalizeParams(p)])
        : (Object.keys(p).length === 2 && p.name && typeof p.value !== "undefined") ||
          (Object.keys(p).length === 3 && p.name && typeof p.value !== "undefined" && p.cast)
        ? acc.concat(p)
        : acc.concat(splitParams(p)),
    []
  ); // end reduce

// Prepare parameters
const processParams: any = (
  engine: any,
  sql: string,
  sqlParams: { [x: string]: { type: string } },
  params: any[],
  formatOptions: any,
  row = 0
) => {
  return {
    processedParams: params.reduce((acc, p) => {
      if (Array.isArray(p)) {
        const result = processParams(engine, sql, sqlParams, p, formatOptions, row);
        if (row === 0) {
          sql = result.escapedSql;
          row++;
        }
        return acc.concat([result.processedParams]);
      } else if (sqlParams[p.name]) {
        if (sqlParams[p.name].type === "n_ph") {
          if (p.cast) {
            const regex = new RegExp(":" + p.name + "\\b", "g");
            sql = sql.replace(
              regex,
              engine === "pg" ? `:${p.name}::${p.cast}` : `CAST(:${p.name} AS ${p.cast})`
            );
          }
          acc.push(formatParam(p.name, p.value, formatOptions));
        } else if (row === 0) {
          const regex = new RegExp("::" + p.name + "\\b", "g");
          sql = sql.replace(regex, sqlString.escapeId(p.value));
        }
        return acc;
      } else {
        return acc;
      }
    }, []),
    escapedSql: sql,
  };
};

// Converts parameter to the name/value format
const formatParam = (n: any, v: any, formatOptions: any) =>
  formatType(n, v, getType(v), getTypeHint(v), formatOptions);

// Converts object params into name/value format
const splitParams = (p: { [x: string]: any }) =>
  Object.keys(p).reduce((arr, x) => arr.concat({ name: x, value: p[x] } as any), []);

// Get all the sql parameters and assign them types
const getSqlParams = (sql: string) => {
  // TODO: probably need to remove comments from the sql
  // TODO: placeholders?
  // sql.match(/\:{1,2}\w+|\?+/g).map((p,i) => {
  return (sql.match(/:{1,2}\w+/g) || [])
    .map((p: string) => {
      // TODO: future support for placeholder parsing?
      // return p === '??' ? { type: 'id' } // identifier
      //   : p === '?' ? { type: 'ph', label: '__d'+i  } // placeholder
      return p.startsWith("::")
        ? { type: "n_id", label: p.substr(2) } // named id
        : { type: "n_ph", label: p.substr(1) }; // named placeholder
    })
    .reduce((acc: any, x: { label: any; type: any }) => {
      return Object.assign(acc, {
        [x.label]: {
          type: x.type,
        },
      });
    }, {}); // end reduce
};

// Gets the value type and returns the correct value field name
// TODO: Support more types as the are released
const getType = (val: string | number | null) =>
  typeof val === "string"
    ? "stringValue"
    : typeof val === "boolean"
    ? "booleanValue"
    : typeof val === "number" && parseInt(val.toString()) === val
    ? "longValue"
    : typeof val === "number" && parseFloat(val.toString()) === val
    ? "doubleValue"
    : val === null
    ? "isNull"
    : isDate(val)
    ? "stringValue"
    : Buffer.isBuffer(val)
    ? "blobValue"
    : // : Array.isArray(val) ? 'arrayValue' This doesn't work yet
    // TODO: there is a 'structValue' now for postgres
    typeof val === "object" &&
      Object.keys(val).length === 1 &&
      supportedTypes.includes(Object.keys(val)[0])
    ? null
    : undefined;

// Hint to specify the underlying object type for data type mapping
const getTypeHint = (val: any) => (isDate(val) ? "TIMESTAMP" : undefined);

const isDate = (val: any) => val instanceof Date;

// Creates a standard Data API parameter using the supplied inputs
const formatType = (
  name: any,
  value: any,
  type: string | null | undefined,
  typeHint: string | null | undefined,
  formatOptions: { treatAsLocalDate: any }
) => {
  return Object.assign(
    typeHint != null ? { name, typeHint } : { name },
    type === null
      ? { value }
      : {
          value: {
            [type ? type : error(`'${name}' is an invalid type`)]:
              type === "isNull"
                ? true
                : isDate(value)
                ? formatToTimeStamp(value, formatOptions && formatOptions.treatAsLocalDate)
                : value,
          },
        }
  );
}; // end formatType

// Formats the (UTC) date to the AWS accepted YYYY-MM-DD HH:MM:SS[.FFF] format
// See https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_SqlParameter.html
const formatToTimeStamp = (
  date: {
    getFullYear: () => any;
    getUTCFullYear: () => any;
    getMonth: () => any;
    getUTCMonth: () => any;
    getDate: () => any;
    getUTCDate: () => any;
    getHours: () => any;
    getUTCHours: () => any;
    getMinutes: () => any;
    getUTCMinutes: () => any;
    getSeconds: () => any;
    getUTCSeconds: () => any;
    getMilliseconds: () => any;
    getUTCMilliseconds: () => any;
  },
  treatAsLocalDate: any
) => {
  const pad = (val: string, num = 2) => "0".repeat(num - (val + "").length) + val;

  const year = treatAsLocalDate ? date.getFullYear() : date.getUTCFullYear();
  const month = (treatAsLocalDate ? date.getMonth() : date.getUTCMonth()) + 1; // Convert to human month
  const day = treatAsLocalDate ? date.getDate() : date.getUTCDate();

  const hours = treatAsLocalDate ? date.getHours() : date.getUTCHours();
  const minutes = treatAsLocalDate ? date.getMinutes() : date.getUTCMinutes();
  const seconds = treatAsLocalDate ? date.getSeconds() : date.getUTCSeconds();
  const ms = treatAsLocalDate ? date.getMilliseconds() : date.getUTCMilliseconds();

  const fraction = ms <= 0 ? "" : `.${pad(ms, 3)}`;

  return `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(
    seconds
  )}${fraction}`;
};

// Converts the string value to a Date object.
// If standard TIMESTAMP format (YYYY-MM-DD[ HH:MM:SS[.FFF]]) without TZ + treatAsLocalDate=false then assume UTC Date
// In all other cases convert value to datetime as-is (also values with TZ info)
const formatFromTimeStamp = (value: string | number | Date, treatAsLocalDate: any) =>
  !treatAsLocalDate && /^\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2}:\d{2}(\.\d{3})?)?$/.test(value as any)
    ? new Date(value + "Z")
    : new Date(value);

// Formats the results of a query response
const formatResults = (
  {
    // destructure results
    columnMetadata, // ONLY when hydrate or includeResultMetadata is true
    numberOfRecordsUpdated, // ONLY for executeStatement method
    records, // ONLY for executeStatement method
    generatedFields, // ONLY for INSERTS
    updateResults, // ONLY on batchExecuteStatement
  }: any,
  hydrate: any,
  includeMeta: boolean,
  formatOptions: any
) =>
  Object.assign(
    includeMeta ? { columnMetadata } : {},
    numberOfRecordsUpdated !== undefined && !records ? { numberOfRecordsUpdated } : {},
    records
      ? {
          records: formatRecords(records, columnMetadata, hydrate, formatOptions),
        }
      : {},
    updateResults ? { updateResults: formatUpdateResults(updateResults) } : {},
    generatedFields && generatedFields.length > 0 ? { insertId: generatedFields[0].longValue } : {}
  );

// Processes records and either extracts Typed Values into an array, or
// object with named column labels
const formatRecords = (recs: any[], columns: any, hydrate: any, formatOptions: any) => {
  // Create map for efficient value parsing
  let fmap =
    recs && recs[0]
      ? recs[0].map((x: any, i: string | number) => {
          return Object.assign(
            {},
            columns ? { label: columns[i].label, typeName: columns[i].typeName } : {}
          ); // add column label and typeName
        })
      : {};

  // Map over all the records (rows)
  return recs
    ? recs.map((rec) => {
        // Reduce each field in the record (row)
        return rec.reduce(
          (acc: any[], field: { [x: string]: any; isNull?: any }, i: string | number) => {
            // If the field is null, always return null
            if (field.isNull === true) {
              return hydrate // object if hydrate, else array
                ? Object.assign(acc, { [fmap[i].label]: null })
                : acc.concat(null);

              // If the field is mapped, return the mapped field
            } else if (fmap[i] && fmap[i].field) {
              const value = formatRecordValue(
                field[fmap[i].field],
                fmap[i].typeName,
                formatOptions
              );
              return hydrate // object if hydrate, else array
                ? Object.assign(acc, { [fmap[i].label]: value })
                : acc.concat(value);

              // Else discover the field type
            } else {
              // Look for non-null fields
              Object.keys(field).map((type) => {
                if (type !== "isNull" && field[type] !== null) {
                  fmap[i]["field"] = type;
                }
              });

              // Return the mapped field (this should NEVER be null)
              const value = formatRecordValue(
                field[fmap[i].field],
                fmap[i].typeName,
                formatOptions
              );
              return hydrate // object if hydrate, else array
                ? Object.assign(acc, { [fmap[i].label]: value })
                : acc.concat(value);
            }
          },
          hydrate ? {} : []
        ); // init object if hydrate, else init array
      })
    : []; // empty record set returns an array
}; // end formatRecords

// Format record value based on its value, the database column's typeName and the formatting options
const formatRecordValue = (
  value: any,
  typeName: string,
  formatOptions: { deserializeDate: any; treatAsLocalDate: any }
) =>
  formatOptions &&
  formatOptions.deserializeDate &&
  ["DATE", "DATETIME", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE"].includes(typeName)
    ? formatFromTimeStamp(
        value,
        (formatOptions && formatOptions.treatAsLocalDate) || typeName === "TIMESTAMP WITH TIME ZONE"
      )
    : value;

// Format updateResults and extract insertIds
const formatUpdateResults = (res: any[]) =>
  res.map((x: { generatedFields: string | any[] }) => {
    return x.generatedFields && x.generatedFields.length > 0
      ? { insertId: x.generatedFields[0].longValue }
      : {};
  });

// Merge configuration data with supplied arguments
const mergeConfig = (initialConfig: {}, args: any) => Object.assign(initialConfig, args);

/********************************************************************/
/**  QUERY MANAGEMENT                                              **/
/********************************************************************/

// Query function (use standard form for `this` context)
const query = async function (
  this: any,
  config: {
    engine: any;
    secretArn?: any;
    resourceArn?: any;
    database?: any;
    hydrateColumnNames?: any;
    formatOptions?: { deserializeDate: boolean; treatAsLocalDate: any };
    RDS: any;
    transactionId?: any;
  },
  ..._args: any[]
) {
  // Flatten array if nested arrays (fixes #30)
  const args = Array.isArray(_args[0]) ? flatten(_args) : _args;

  // Parse and process sql
  const sql = parseSQL(args);
  const sqlParams = getSqlParams(sql);

  // Parse hydration setting
  const hydrateColumnNames = parseHydrate(config, args);

  // Parse data format settings
  const formatOptions = parseFormatOptions(config, args);

  // Parse and normalize parameters
  const parameters = normalizeParams(parseParams(args));

  // Process parameters and escape necessary SQL
  const { processedParams, escapedSql } = processParams(
    config.engine,
    sql,
    sqlParams,
    parameters,
    formatOptions
  );

  // Determine if this is a batch request
  const isBatch = processedParams.length > 0 && Array.isArray(processedParams[0]);

  // Create/format the parameters
  const params = Object.assign(
    prepareParams(config, args),
    {
      database: parseDatabase(config, args), // add database
      sql: escapedSql, // add escaped sql statement
    },
    // Only include parameters if they exist
    processedParams.length > 0
      ? // Batch statements require parameterSets instead of parameters
        { [isBatch ? "parameterSets" : "parameters"]: processedParams }
      : {},
    // Force meta data if set and not a batch
    hydrateColumnNames && !isBatch ? { includeResultMetadata: true } : {},
    // If a transactionId is passed, overwrite any manual input
    config.transactionId ? { transactionId: config.transactionId } : {}
  ); // end params

  try {
    // attempt to run the query

    // Capture the result for debugging
    let result = await (isBatch
      ? config.RDS.batchExecuteStatement(params)
      : config.RDS.executeStatement(params));

    // Format and return the results
    return formatResults(
      result,
      hydrateColumnNames,
      args[0].includeResultMetadata === true,
      formatOptions
    );
  } catch (e) {
    const _this: any = this;
    if (_this && _this.rollback) {
      let rollback = await config.RDS.rollbackTransaction(
        pick(params, ["resourceArn", "secretArn", "transactionId"])
      );

      _this.rollback(e, rollback);
    }
    // Throw the error
    throw e;
  }
}; // end query

/********************************************************************/
/**  TRANSACTION MANAGEMENT                                        **/
/********************************************************************/

// Init a transaction object and return methods
const transaction = (
  config: {
    engine?: any;
    secretArn?: any;
    resourceArn?: any;
    database?: any;
    hydrateColumnNames?: any;
    formatOptions?: { deserializeDate: boolean; treatAsLocalDate: any };
    RDS: any;
  },
  _args: any
) => {
  let args = typeof _args === "object" ? [_args] : [{}];
  let queries: (() => any[])[] = []; // keep track of queries
  let rollback = () => {}; // default rollback event

  const txConfig = Object.assign(prepareParams(config, args), {
    database: parseDatabase(config, args), // add database
    hydrateColumnNames: parseHydrate(config, args), // add hydrate
    formatOptions: parseFormatOptions(config, args), // add formatOptions
    RDS: config.RDS, // reference the RDSDataService instance
  });

  return {
    query: function (...args: any[]) {
      if (typeof args[0] === "function") {
        queries.push(args[0]);
      } else {
        queries.push(() => [...args]);
      }
      return this;
    },
    rollback: function (fn: () => void) {
      if (typeof fn === "function") {
        rollback = fn;
      }
      return this;
    },
    commit: async function () {
      return await commit(txConfig, queries, rollback);
    },
  };
};

// Commit transaction by running queries
const commit = async (
  config: { secretArn: any; resourceArn: any } & {
    database: any; // add database
    hydrateColumnNames: any; // add hydrate
    formatOptions: any; // add formatOptions
    RDS: any;
  },
  queries: string | any[],
  rollback: () => void
) => {
  let results = []; // keep track of results

  // Start a transaction
  const { transactionId } = await config.RDS.beginTransaction(
    pick(config, ["resourceArn", "secretArn", "database"])
  );

  // Add transactionId to the config
  let txConfig = Object.assign(config, { transactionId });

  // Loop through queries
  for (let i = 0; i < queries.length; i++) {
    // Execute the queries, pass the rollback as context
    let result: any = await query.apply({ rollback }, [
      config as any,
      queries[i](results[results.length - 1], results),
    ]);
    // Add the result to the main results accumulator
    results.push(result);
  }

  // Commit our transaction
  const { transactionStatus } = await txConfig.RDS.commitTransaction(
    pick(config, ["resourceArn", "secretArn", "transactionId"])
  );

  // Add the transaction status to the results
  results.push({ transactionStatus });

  // Return the results
  return results;
};

/********************************************************************/
/**  INSTANTIATION                                                 **/
/********************************************************************/

// Export main function
/**
 * Create a Data API client instance
 * @param {object} params
 * @param {'mysql'|'pg'} [params.engine=mysql] The type of database (MySQL or Postgres)
 * @param {string} params.resourceArn The ARN of your Aurora Serverless Cluster
 * @param {string} params.secretArn The ARN of the secret associated with your
 *   database credentials
 * @param {string} [params.database] The name of the database
 * @param {boolean} [params.hydrateColumnNames=true] Return objects with column
 *   names as keys
 * @param {object} [params.options={}] Configuration object passed directly
 *   into RDSDataService
 * @param {object} [params.formatOptions] Date-related formatting options
 * @param {boolean} [params.formatOptions.deserializeDate=false]
 * @param {boolean} [params.formatOptions.treatAsLocalDate=false]
 * @param {boolean} [params.keepAlive] DEPRECATED
 * @param {boolean} [params.sslEnabled=true] DEPRECATED
 * @param {string} [params.region] DEPRECATED
 *
 */
const init = (params: any) => {
  // Set the options for the RDSDataService
  const options: any =
    typeof params.options === "object"
      ? params.options
      : params.options !== undefined
      ? error("'options' must be an object")
      : {};

  // Update the AWS http agent with the region
  if (typeof params.region === "string") {
    options.region = params.region;
  }

  // Disable ssl if wanted for local development
  if (params.sslEnabled === false) {
    options.tls = false;
  }

  // Set the configuration for this instance
  const config = {
    // Require engine
    engine: typeof params.engine === "string" ? params.engine : "mysql",

    // Require secretArn
    secretArn:
      typeof params.secretArn === "string"
        ? params.secretArn
        : error("'secretArn' string value required"),

    // Require resourceArn
    resourceArn:
      typeof params.resourceArn === "string"
        ? params.resourceArn
        : error("'resourceArn' string value required"),

    // Load optional database
    database:
      typeof params.database === "string"
        ? params.database
        : params.database !== undefined
        ? error("'database' must be a string")
        : undefined,

    // Load optional schema DISABLED for now since this isn't used with MySQL
    // schema: typeof params.schema === 'string' ? params.schema
    //   : params.schema !== undefined ? error(`'schema' must be a string`)
    //   : undefined,

    // Set hydrateColumnNames (default to true)
    hydrateColumnNames:
      typeof params.hydrateColumnNames === "boolean" ? params.hydrateColumnNames : true,

    // Value formatting options. For date the deserialization is enabled and (re)stored as UTC
    formatOptions: {
      deserializeDate:
        typeof params.formatOptions === "object" && params.formatOptions.deserializeDate === false
          ? false
          : true,
      treatAsLocalDate:
        typeof params.formatOptions === "object" && params.formatOptions.treatAsLocalDate,
    },

    // TODO: Put this in a separate module for testing?
    // Create an instance of RDSDataService
    RDS: new RDSData(options),
  }; // end config

  // Return public methods
  return {
    // Query method, pass config and parameters
    query: (...x: any) => query(config, ...x),
    // Transaction method, pass config and parameters
    transaction: (x: any) => transaction(config, x),

    // Export methods from RDSData
    batchExecuteStatement: (args: any) =>
      config.RDS.batchExecuteStatement(
        mergeConfig(pick(config, ["resourceArn", "secretArn", "database"]), args)
      ),
    beginTransaction: (args: any) =>
      config.RDS.beginTransaction(
        mergeConfig(pick(config, ["resourceArn", "secretArn", "database"]), args)
      ),
    commitTransaction: (args: any) =>
      config.RDS.commitTransaction(mergeConfig(pick(config, ["resourceArn", "secretArn"]), args)),
    executeStatement: (args: any) =>
      config.RDS.executeStatement(
        mergeConfig(pick(config, ["resourceArn", "secretArn", "database"]), args)
      ),
    rollbackTransaction: (args: any) =>
      config.RDS.rollbackTransaction(mergeConfig(pick(config, ["resourceArn", "secretArn"]), args)),
  };
}; // end exports

export default init;
