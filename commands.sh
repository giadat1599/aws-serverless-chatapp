
# 1. Zip the file
zip -r handler.zip handler.js

# 2. Create lambda function
aws lambda create-function --function-name serverless-chatapp-lambda --runtime "nodejs18.x" --role <ARN_ROLE> --zip-file "fileb://handler.zip" --handler handler.handler

# 3. Update lambda function code (NOTE: Run this ONLY if you want to update your lambda function code)
aws lambda update-function-code --function-name serverless-chatapp-lambda --zip-file "fileb://handler.zip"
