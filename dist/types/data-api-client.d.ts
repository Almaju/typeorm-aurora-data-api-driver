/********************************************************************/
/**  INSTANTIATION                                                 **/
/********************************************************************/
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
declare const init: (params: any) => {
    query: (...x: any) => Promise<any>;
    transaction: (x: any) => {
        query: (...args: any[]) => any;
        rollback: (fn: () => void) => any;
        commit: () => Promise<any[]>;
    };
    batchExecuteStatement: (args: any) => Promise<import("@aws-sdk/client-rds-data/dist-types/").BatchExecuteStatementCommandOutput>;
    beginTransaction: (args: any) => Promise<import("@aws-sdk/client-rds-data/dist-types/").BeginTransactionCommandOutput>;
    commitTransaction: (args: any) => Promise<import("@aws-sdk/client-rds-data/dist-types/").CommitTransactionCommandOutput>;
    executeStatement: (args: any) => Promise<import("@aws-sdk/client-rds-data/dist-types/").ExecuteStatementCommandOutput>;
    rollbackTransaction: (args: any) => Promise<import("@aws-sdk/client-rds-data/dist-types/").RollbackTransactionCommandOutput>;
};
export default init;
