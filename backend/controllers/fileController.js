const File = require('../models/File');
const Message = require('../models/Message');
const Room = require('../models/Room');
const { processFileForRAG } = require('../services/fileService');
const path = require('path');
const crypto = require('crypto');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand,DeleteObjectCommand,PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = require('../utils/s3Client'); 


const isPathSafe = (filepath, directory) => {
  const resolvedPath = path.resolve(filepath);
  const resolvedDirectory = path.resolve(directory);
  return resolvedPath.startsWith(resolvedDirectory);
};

const generateSafeFilename = (originalFilename) => {
  const ext = path.extname(originalFilename || '').toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `${timestamp}_${randomBytes}${ext}`;
};

// 개선된 파일 정보 조회 함수
const getFileFromRequest = async (req) => {
  const filename = req.params.filename;
  const token = req.headers['x-auth-token'] || req.query.token;
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;

  if (!filename) throw new Error('Invalid filename');
  if (!token || !sessionId) throw new Error('Authentication required');

  const file = await File.findOne({ filename });
  if (!file) throw new Error('File not found in database');

  const message = await Message.findOne({ file: file._id });
  if (!message) throw new Error('File message not found');

  const room = await Room.findOne({
    _id: message.room,
    participants: req.user.id
  });
  if (!room) throw new Error('Unauthorized access');

  return { file };
};

exports.uploadFile = async (req, res) => {
  try {
    // ✅ Presigned URL 업로드 방식 처리
    if (!req.file && req.body.path && req.body.url) {
      const {
        filename,
        originalname,
        mimetype,
        size,
        path,
        url
      } = req.body;

      const file = new File({
        filename,
        originalname,
        mimetype,
        size,
        user: req.user.id,
        path,
        url
      });

      await file.save();

      return res.status(200).json({
        success: true,
        message: '파일 메타데이터가 저장되었습니다.',
        file
      });
    }

    // ✅ 기존 multer-s3 업로드 방식 처리
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '파일이 선택되지 않았습니다.'
      });
    }

    const safeFilename = req.file.key?.split('/').pop();
    const s3Key = req.file.key;
    const s3Url = req.file.location;

    const file = new File({
      filename: safeFilename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      path: s3Key,
      url: s3Url
    });

    await file.save();

    return res.status(200).json({
      success: true,
      message: '파일 업로드 성공',
      file
    });

  } catch (error) {
    console.error('File upload error:', error);
    return res.status(500).json({
      success: false,
      message: '파일 업로드 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: file.path,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(file.originalname)}"`
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    return res.redirect(signedUrl);

  } catch (error) {
    handleFileError(error, res);
  }
};

exports.getPresignedUploadUrl = async (req, res) => {
  const { originalname, mimetype, size } = req.body;
  const filename = generateSafeFilename(originalname); // timestamp + random
  const userHash = crypto.createHash('md5').update(req.user.id).digest('hex').slice(0, 2);
  const now = new Date();
  const prefix = `uploads/${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()}/${userHash}`;
  const key = `${prefix}/${filename}`;

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    ContentType: mimetype,
    Metadata: {
      uploadedBy: req.user.id
    }
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

  res.json({
    uploadUrl,
    fileKey: key,
    fileUrl: `https://${process.env.AWS_BUCKET_NAME}.s3.ap-northeast-2.amazonaws.com/${key}`
  });
};

exports.viewFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    if (!file.isPreviewable()) {
      return res.status(415).json({ success: false, message: '미리보기를 지원하지 않는 파일 형식입니다.' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: file.path
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 }); // 60초 유효

    return res.redirect(signedUrl);

  } catch (error) {
    handleFileError(error, res);
  }
};

const handleFileStream = (fileStream, res) => {
  fileStream.on('error', (error) => {
    console.error('File streaming error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: '파일 스트리밍 중 오류가 발생했습니다.'
      });
    }
  });

  fileStream.pipe(res);
};

const handleFileError = (error, res) => {
  console.error('File operation error:', {
    message: error.message,
    stack: error.stack
  });

  // 에러 상태 코드 및 메시지 매핑
  const errorResponses = {
    'Invalid filename': { status: 400, message: '잘못된 파일명입니다.' },
    'Authentication required': { status: 401, message: '인증이 필요합니다.' },
    'Invalid file path': { status: 400, message: '잘못된 파일 경로입니다.' },
    'File not found in database': { status: 404, message: '파일을 찾을 수 없습니다.' },
    'File message not found': { status: 404, message: '파일 메시지를 찾을 수 없습니다.' },
    'Unauthorized access': { status: 403, message: '파일에 접근할 권한이 없습니다.' },
    'ENOENT': { status: 404, message: '파일을 찾을 수 없습니다.' }
  };

  const errorResponse = errorResponses[error.message] || {
    status: 500,
    message: '파일 처리 중 오류가 발생했습니다.'
  };

  res.status(errorResponse.status).json({
    success: false,
    message: errorResponse.message
  });
};

exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: '파일을 찾을 수 없습니다.' });
    if (file.user.toString() !== req.user.id) return res.status(403).json({ success: false, message: '파일을 삭제할 권한이 없습니다.' });

    const deleteCommand = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: file.path
    });

    await s3.send(deleteCommand);
    await file.deleteOne();

    res.json({ success: true, message: '파일이 삭제되었습니다.' });

  } catch (error) {
    console.error('File deletion error:', error);
    res.status(500).json({ success: false, message: '파일 삭제 중 오류가 발생했습니다.', error: error.message });
  }
};