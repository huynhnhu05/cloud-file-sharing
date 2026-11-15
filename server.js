const express = require('express');
const cors = require('cors');
const multer = require('multer');
const {
  S3Client, PutObjectCommand, ListObjectsV2Command,
  GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Trang kiểm tra server còn sống (Render dùng để health check)
app.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'Backend S3 đang hoạt động' });
});

// 1. CẤU HÌNH S3 CLIENT KẾT NỐI VỚI AWS
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 2. CẤU HÌNH MULTER: LƯU TẠM VÀO RAM, GIỚI HẠN 10MB, LỌC LOẠI TỆP
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/png',
      'image/jpeg',
      'image/jpg', // Thêm dòng này cho chắc chắn
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    const e = new Error('Định dạng tệp không được hỗ trợ!');
    e.code = 'INVALID_FILE_TYPE';
    cb(e);
  },
});

// 3. API CHỨC NĂNG 1: UPLOAD
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'Vui lòng chọn 1 tệp tin!' });
    }

    const timeStamp = Date.now();
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const sanitizedFileName = originalName.replace(/\s+/g, '_');
    const uniqueKey = `${timeStamp}_${sanitizedFileName}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: uniqueKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    return res.status(200).json({
      success: true,
      message: 'Tải tệp tin lên Amazon S3 thành công!',
      data: {
        fileName: uniqueKey,
        originalName,
        size: file.size,
        mimeType: file.mimetype,
      },
    });
  } catch (error) {
    console.error('Upload Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Lỗi tải tệp tin lên Amazon S3',
      error: error.message,
    });
  }
});

// 4. API CHỨC NĂNG 2: DANH SÁCH TỆP
app.get('/api/files', async (req, res) => {
  try {
    const data = await s3Client.send(
      new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET_NAME })
    );

    if (!data.Contents || data.Contents.length === 0) {
      return res.status(200).json({ success: true, count: 0, files: [] });
    }

    const fileList = data.Contents.map((item) => ({
      key: item.Key,
      size: item.Size,
      sizeInKB: (item.Size / 1024).toFixed(2) + ' KB',
      lastModified: item.LastModified,
    }));

    return res.status(200).json({ success: true, count: fileList.length, files: fileList });
  } catch (error) {
    console.error('List Files Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Lỗi khi lấy danh sách tệp từ Amazon S3',
      error: error.message,
    });
  }
});

// Kiểm tra tệp có tồn tại trên S3 không
async function tonTai(key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
    return true;
  } catch (e) {
    return false;
  }
}

// 5. API CHỨC NĂNG 3: TẢI XUỐNG (STREAMING)
app.get('/api/download/:filename', async (req, res) => {
  try {
    const key = req.params.filename;
    if (!(await tonTai(key))) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tệp tin!' });
    }
    const data = await s3Client.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key })
    );
    res.setHeader('Content-Type', data.ContentType || 'application/octet-stream');
    if (data.ContentLength) res.setHeader('Content-Length', data.ContentLength);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(key)}`);
    data.Body.on('error', (err) => {
      console.error('Stream Error:', err);
      res.destroy(err);
    });
    data.Body.pipe(res);
  } catch (error) {
    console.error('Download Error:', error);
    res.status(500).json({ success: false, message: 'Lỗi tải tệp từ Amazon S3', error: error.message });
  }
});

// 6. API CHỨC NĂNG 4: CHIA SẺ (PRESIGNED URL, HẾT HẠN SAU 15 PHÚT)
app.get('/api/share/:filename', async (req, res) => {
  try {
    const key = req.params.filename;
    if (!(await tonTai(key))) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tệp tin!' });
    }
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }),
      { expiresIn: 900 }
    );
    res.status(200).json({ success: true, url, expiresInSeconds: 900 });
  } catch (error) {
    console.error('Share Error:', error);
    res.status(500).json({ success: false, message: 'Lỗi tạo link chia sẻ', error: error.message });
  }
});

// 7. API CHỨC NĂNG 5: XÓA TỆP
app.delete('/api/delete/:filename', async (req, res) => {
  try {
    const key = req.params.filename;
    if (!(await tonTai(key))) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tệp tin!' });
    }
    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
    res.status(200).json({ success: true, message: 'Xóa thành công' });
  } catch (error) {
    console.error('Delete Error:', error);
    res.status(500).json({ success: false, message: 'Lỗi xóa tệp từ Amazon S3', error: error.message });
  }
});

// 8. BẮT LỖI UPLOAD (phải nằm sau tất cả các route)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Tệp vượt quá giới hạn 10MB!' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ success: false, message: 'Sai tên trường tệp, cần dùng "file"!' });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err && err.code === 'INVALID_FILE_TYPE') {
    return res.status(415).json({ success: false, message: err.message });
  }
  next(err);
});

// KÍCH HOẠT SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Backend đang chạy tại cổng ${PORT}`);
});