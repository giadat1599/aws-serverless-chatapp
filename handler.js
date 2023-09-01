const { DynamoDB } = require("aws-sdk");

const CLIENT_TABLE_NAME = process.env.CLIENT_TABLE_NAME;
const ddbClient = new DynamoDB.DocumentClient({ region: process.env.REGION });

const handleConnect = async (connectionId) => {
   try {
      await ddbClient
         .put({
            TableName: String(CLIENT_TABLE_NAME),
            Item: {
               connectionId,
            },
         })
         .promise();
   } catch (err) {
      return { body: "Client failed to connect: " + JSON.stringify(err), statusCode: 500 };
   }

   return {
      body: "Client connected",
      statusCode: 200,
   };
};

const handleDisconnect = async (connectionId) => {
   try {
      await ddbClient
         .delete({
            TableName: String(CLIENT_TABLE_NAME),
            Key: {
               connectionId,
            },
         })
         .promise();
   } catch (err) {
      return { body: "Client failed to disconnect: " + JSON.stringify(err), statusCode: 500 };
   }
   return {
      body: "Client disconnected",
      statusCode: 200,
   };
};

exports.handler = async (event) => {
      const connectionId = event.requestContext?.connectionId || undefined;
      const routeKey = event.requestContext?.routeKey || undefined
      switch (routeKey) {
         case "$connect":
            return handleConnect(connectionId);
         case "$disconnect":
            return handleDisconnect(connectionId);
         default:
            return {
               body: "Something Went Wrong",
               statusCode: 500,
            };
      }
};
