const express = require('express');
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
require('dotenv').config(); // Đọc file biến môi trường .env

const app = express();
const PORT = process.env.PORT || 5000;

// Khởi tạo kết nối tới Amazon S3
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 1. API Tải xuống tệp (Download)
app.get('/download/:filename', async (req, res) => {
  const filename = req.params.filename;
  
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: filename,
  };

  try {
    const command = new GetObjectCommand(params);
    const response = await s3Client.send(command);
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', response.ContentType || 'application/octet-stream');
    
    response.Body.pipe(res);
  } catch (error) {
    console.error("Lỗi tải xuống:", error);
    res.status(500).send("Không thể tải xuống tệp tin từ đám mây.");
  }
});

// 2. API Tạo link chia sẻ tạm thời (Share Link - Hết hạn sau 15 phút)
app.get('/share/:filename', async (req, res) => {
  const filename = req.params.filename;
  
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: filename,
  });

  try {
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
    res.json({ shareUrl: signedUrl });
  } catch (error) {
    console.error("Lỗi tạo link chia sẻ:", error);
    res.status(500).send("Không thể tạo liên kết chia sẻ tệp tin.");
  }
});

// 3. API Xóa tệp tin (Delete)
app.delete('/delete/:filename', async (req, res) => {
  const filename = req.params.filename;
  
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: filename,
  };

  try {
    const command = new DeleteObjectCommand(params);
    await s3Client.send(command);
    res.status(200).json({ message: "Xóa tệp tin thành công!" });
  } catch (error) {
    console.error("Lỗi xóa tệp:", error);
    res.status(500).send("Không thể xóa tệp tin từ đám mây.");
  }
});

// Khởi chạy server
app.listen(PORT, () => {
  console.log(`Server đang chạy tại cổng ${PORT}`);
});