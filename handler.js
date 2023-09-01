const {
   DynamoDBClient,
   PutItemCommand,
   DeleteItemCommand,
   ScanCommand,
   QueryCommand,
   GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const {
   ApiGatewayManagementApiClient,
   PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");

// Services initialization

const CLIENT_TABLE_NAME = process.env.CLIENT_TABLE_NAME;
const MESSAGE_TABLE_NAME = process.env.MESSAGE_TABLE_NAME;
const WSGATEWAY_ENDPOINT = process.env.WSGATEWAY_ENDPOINT;
const REGION = process.env.REGION;

const ddbClient = new DynamoDBClient({ region: REGION });

const apiGW = new ApiGatewayManagementApiClient({
   endpoint: WSGATEWAY_ENDPOINT,
   region: REGION,
});

// Resuable functions

const create_UUID = () => {
   let dt = new Date().getTime();
   let uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      let r = (dt + Math.random() * 16) % 16 | 0;
      dt = Math.floor(dt / 16);
      return (c == "x" ? r : (r & 0x3) | 0x8).toString(16);
   });
   return uuid;
};

const cleanResp = (resp) => {
   return Object.keys(resp).reduce(
      (acc, curr) => ({ ...acc, [curr]: resp[curr].S || resp[curr].N }),
      {},
   );
};

const parseSendMsgBody = (body) => {
   const sendBody = JSON.parse(body || "{}");

   if (
      !sendBody ||
      typeof sendBody.message !== "string" ||
      typeof sendBody.recipientNickname !== "string"
   ) {
      throw new Error("Incorrect send message body format");
   }
   return sendBody;
};

const parseGetMsgsBody = (body) => {
   const getMsgBody = JSON.parse(body || "{}");

   if (
      !getMsgBody ||
      typeof getMsgBody.targetNickname !== "string" ||
      typeof getMsgBody.limit !== "number"
   ) {
      throw new Error("Incorrect get messages body format");
   }
   return getMsgBody;
};

const parseTypingMsgBody = (body) => {
   const typingMsgBody = JSON.parse(body || "{}");

   if (
      !typingMsgBody ||
      typeof typingMsgBody.targetNickname !== "string" ||
      typeof typingMsgBody.isTyping !== "boolean"
   ) {
      throw new Error("Incorrect typing message body format");
   }
   return typingMsgBody;
};

const getNicknameToNickname = (nicknames) => {
   return nicknames.sort().join("#");
};

const getConnectionIdByNickname = async (nickname) => {
   const output = await ddbClient.send(
      new QueryCommand({
         TableName: CLIENT_TABLE_NAME,
         IndexName: "nickname-index",
         KeyConditionExpression: "#nickname = :nickname",
         ExpressionAttributeNames: {
            "#nickname": "nickname",
         },
         ExpressionAttributeValues: {
            ":nickname": {
               S: nickname,
            },
         },
      }),
   );

   if (output.Count && output.Count > 0) {
      const client = output.Items.map((item) => cleanResp(item))[0];
      return client.connectionId;
   }
   return undefined;
};

const getClientByConnectionid = async (connectionId) => {
   const output = await ddbClient.send(
      new GetItemCommand({
         TableName: CLIENT_TABLE_NAME,
         Key: {
            connectionId: {
               S: connectionId,
            },
         },
      }),
   );

   return cleanResp(output.Item);
};

const getAllClients = async () => {
   const output = await ddbClient.send(new ScanCommand({ TableName: CLIENT_TABLE_NAME }));
   return (output.Items || []).map((item) => cleanResp(item));
};

const postToConnection = async (connectionId, data) => {
   try {
      await apiGW.send(
         new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(data),
         }),
      );
      return true;
   } catch (err) {
      if (err.statusCode !== 410) {
         throw err;
      } else {
         await ddbClient.send(
            new DeleteItemCommand({
               TableName: CLIENT_TABLE_NAME,
               Key: {
                  connectionId: {
                     S: connectionId,
                  },
               },
            }),
         );
         return false;
      }
   }
};

const notifyClients = async (excludedConnectionId) => {
   const clients = await getAllClients();
   await Promise.all(
      clients
         .filter((client) => client.connectionId !== excludedConnectionId)
         .map((client) =>
            postToConnection(client.connectionId, { type: "clients", data: { clients } }),
         ),
   );
};

// Handle websocket actions

const handleConnect = async (connectionId, queryParams) => {
   if (!queryParams || !queryParams["nickname"]) {
      return {
         body: "nickname is required",
         statusCode: 403,
      };
   }
   const existingConnectionId = await getConnectionIdByNickname(queryParams["nickname"]);
   if (existingConnectionId && (await postToConnection(existingConnectionId, { type: "ping" }))) {
      return {
         satusCode: 403,
         body: "",
      };
   }

   try {
      await ddbClient.send(
         new PutItemCommand({
            TableName: CLIENT_TABLE_NAME,
            Item: {
               connectionId: {
                  S: connectionId,
               },
               nickname: {
                  S: queryParams["nickname"],
               },
            },
         }),
      );
   } catch (err) {
      return { body: "Client failed to connect: " + JSON.stringify(err), statusCode: 500 };
   }

   await notifyClients(connectionId);

   return {
      body: "Client connected",
      statusCode: 200,
   };
};

const handleDisconnect = async (connectionId) => {
   try {
      await ddbClient.send(
         new DeleteItemCommand({
            TableName: CLIENT_TABLE_NAME,
            Key: {
               connectionId: {
                  S: connectionId,
               },
            },
         }),
      );
   } catch (err) {
      return { body: "Client failed to disconnect: " + JSON.stringify(err), statusCode: 500 };
   }

   await notifyClients(connectionId);

   return {
      body: "Client disconnected",
      statusCode: 200,
   };
};

const handleGetClients = async (connectionId) => {
   const clients = await getAllClients();

   await postToConnection(connectionId, { type: "clients", data: { clients } });

   return {
      body: "Get clients successfully",
      statusCode: 200,
   };
};

const handleSendMessage = async (senderConnectionId, body) => {
   const senderNickname = (await getClientByConnectionid(senderConnectionId)).nickname;
   const recipientNickname = body.recipientNickname;
   const nickNameToNickname = getNicknameToNickname([senderNickname, recipientNickname]);
   const message = {
      messageId: create_UUID(),
      createdAt: new Date().getTime().toString(),
      nicknameToNickname: nickNameToNickname,
      message: body.message,
      sender: senderNickname,
   };

   await ddbClient.send(
      new PutItemCommand({
         TableName: MESSAGE_TABLE_NAME,
         Item: {
            messageId: {
               S: message.messageId,
            },
            createdAt: {
               N: message.createdAt,
            },
            nicknameToNickname: {
               S: message.nicknameToNickname,
            },
            message: {
               S: message.message,
            },
            sender: {
               S: message.sender,
            },
         },
      }),
   );

   const recipientConnectionId = await getConnectionIdByNickname(recipientNickname);

   if (recipientConnectionId) {
      await postToConnection(recipientConnectionId, {
         type: "message",
         data: {
            message,
         },
      });
   }
   return {
      statusCode: 200,
      body: "",
   };
};

const handleGetMessages = async (connectionId, body) => {
   const client = await getClientByConnectionid(connectionId);
   const nickNameToNickname = getNicknameToNickname([client.nickname, body.targetNickname]);
   const output = await ddbClient.send(
      new QueryCommand({
         TableName: MESSAGE_TABLE_NAME,
         IndexName: "nickname-to-nickname-index",
         KeyConditionExpression: "#nicknameToNickName = :nicknameToNickName",
         ExpressionAttributeNames: {
            "#nicknameToNickName": "nicknameToNickname",
         },
         ExpressionAttributeValues: {
            ":nicknameToNickName": {
               S: nickNameToNickname,
            },
         },
         Limit: body.limit,
         ExclusiveStartKey: body.startKey
            ? {
                 messageId: {
                    S: body.startKey,
                 },
              }
            : undefined,
         ScanIndexForward: false,
      }),
   );
   const messages = output.Items && output.Items.length > 0 ? output.Items : [];
   const cleanMessagesResp = messages.map((message) => cleanResp(message));

   await postToConnection(connectionId, {
      type: "messages",
      data: { messages: cleanMessagesResp },
   });

   return {
      statusCode: 200,
      body: "",
   };
};

const handleTypingMessage = async (connectionId, body) => {
   const nickNameTyping = (await getClientByConnectionid(connectionId)).nickname;
   const targetConnectionId = await getConnectionIdByNickname(body.targetNickname);

   if (body.isTyping) {
      await postToConnection(targetConnectionId, {
         type: "typing",
         isTyping: true,
         nickNameTyping,
      });
   } else {
      await postToConnection(targetConnectionId, {
         type: "typing",
         isTyping: false,
         nickNameTyping,
      });
   }
};

// Main handler...
exports.handler = async (event) => {
   const connectionId = event.requestContext?.connectionId || undefined;
   const routeKey = event.requestContext?.routeKey || undefined;
   try {
      switch (routeKey) {
         case "$connect":
            return handleConnect(connectionId, event.queryStringParameters);
         case "$disconnect":
            return handleDisconnect(connectionId);
         case "getClients":
            return handleGetClients(connectionId);
         case "sendMessage":
            return handleSendMessage(connectionId, parseSendMsgBody(event.body));
         case "getMessages":
            return handleGetMessages(connectionId, parseGetMsgsBody(event.body));
         case "typingMessage":
            return handleTypingMessage(connectionId, parseTypingMsgBody(event.body));
         default:
            return {
               body: "Something Went Wrong",
               statusCode: 500,
            };
      }
   } catch (e) {
      if (e instanceof Error) {
         await postToConnection(connectionId, e.message);
         return {
            body: "Get clients successfully",
            statusCode: 200,
         };
      }
      throw e;
   }
};
