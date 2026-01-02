import os
import sys
import logging
import threading
import time
import argparse
import datetime
import jwt
from functools import wraps
from flask import Flask, send_from_directory, jsonify, request, Response, make_response
from flask_cors import CORS
from database.db import Database
from utils.email import EmailBatchProcessor, OutlookMailHandler
from ws_server.handler import WebSocketHandler
import asyncio
import concurrent.futures

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("FireMail.log", encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('FireMail')

# 确保数据目录存在
data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(data_dir, exist_ok=True)

# 初始化Flask应用
app = Flask(__name__)
CORS(app, supports_credentials=True, resources={r"/api/*": {"origins": "*"}})  # 允许跨域请求和凭据

# 增加捕获所有OPTIONS请求的处理方法，支持预检请求
@app.route('/', defaults={'path': ''}, methods=['OPTIONS'])
@app.route('/<path:path>', methods=['OPTIONS'])
def handle_options(path):
    """处理所有OPTIONS请求"""
    response = make_response()
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    response.headers.add('Access-Control-Allow-Credentials', 'true')
    return response

# JWT密钥
JWT_SECRET = os.environ.get('JWT_SECRET_KEY', 'huohuo_email_secret_key')

# 打印所有环境变量，帮助调试
print("\n========= 环境变量 =========")
for key, value in os.environ.items():
    if key in ['JWT_SECRET_KEY', 'HOST', 'FLASK_PORT', 'WS_PORT', 'API_URL', 'WS_URL']:
        print(f"{key}: {value}")
print("===========================\n")

# 初始化数据库
db = Database()

# 确保注册功能默认开启，只通过数据库控制
allow_register = db.is_registration_allowed()
logger.info(f"系统启动: 注册功能状态 = {allow_register}")

# 初始化邮件处理器
email_processor = EmailBatchProcessor(db)

# 初始化WebSocket处理器
ws_handler = WebSocketHandler()
ws_handler.set_dependencies(db, email_processor)

# 用户认证装饰器
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None

        # 从请求头或Cookie获取token
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            if auth_header.startswith('Bearer '):
                token = auth_header.split(" ")[1]
        elif request.cookies.get('token'):
            token = request.cookies.get('token')

        if not token:
            return jsonify({'error': '未认证，请先登录'}), 401

        try:
            data = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            current_user = db.get_user_by_id(data['user_id'])
            if not current_user:
                return jsonify({'error': '无效的用户令牌'}), 401
        except jwt.ExpiredSignatureError:
            return jsonify({'error': '令牌已过期，请重新登录'}), 401
        except Exception as e:
            logger.error(f"令牌验证失败: {str(e)}")
            return jsonify({'error': '无效的令牌'}), 401

        # 将当前用户信息添加到kwargs
        kwargs['current_user'] = current_user
        return f(*args, **kwargs)

    return decorated

# 管理员权限装饰器
def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        current_user = kwargs.get('current_user')
        if not current_user or not current_user['is_admin']:
            return jsonify({'error': '需要管理员权限'}), 403
        return f(*args, **kwargs)

    return decorated

# 认证相关API
@app.route('/api/auth/login', methods=['POST'])
def login():
    """用户登录"""
    try:
        data = request.json
        if not data:
            logger.error("登录请求没有JSON数据")
            return jsonify({'error': '无效的请求数据格式'}), 400

        username = data.get('username')
        password = data.get('password')

        logger.info(f"收到登录请求: 用户名={username}")

        if not username or not password:
            logger.warning("登录失败: 用户名或密码为空")
            return jsonify({'error': '用户名和密码不能为空'}), 400

        user = db.authenticate_user(username, password)
        if not user:
            logger.warning(f"登录失败: 用户名或密码错误, 用户名={username}")
            return jsonify({'error': '用户名或密码错误'}), 401

        # 确保user对象包含所有必要属性
        if 'id' not in user or 'username' not in user or 'is_admin' not in user:
            logger.error(f"用户对象缺少必要字段: {user}")
            return jsonify({'error': '内部服务器错误'}), 500

        # 生成JWT令牌
        token = jwt.encode({
            'user_id': user['id'],
            'username': user['username'],
            'is_admin': user['is_admin'],
            'exp': datetime.datetime.utcnow() + datetime.timedelta(days=7)
        }, JWT_SECRET, algorithm="HS256")

        # 创建响应
        response_data = {
            'token': token,
            'user': {
                'id': user['id'],
                'username': user['username'],
                'is_admin': user['is_admin']
            }
        }

        logger.info(f"登录成功: 用户名={username}, 用户ID={user['id']}")

        # 创建JSON响应并设置CORS头
        response = make_response(jsonify(response_data))
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
        response.headers.add('Access-Control-Allow-Methods', 'POST')

        # 设置Cookie
        response.set_cookie(
            'token',
            token,
            httponly=True,
            max_age=7*24*60*60,  # 7天
            secure=False,  # 开发环境设为False，生产环境设为True
            samesite='Lax'
        )

        logger.info(f"用户 {username} 登录成功")
        return response
    except Exception as e:
        logger.error(f"登录过程中发生错误: {str(e)}")
        return jsonify({'error': f'服务器错误: {str(e)}'}), 500

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    """用户登出"""
    response = make_response(jsonify({'message': '已成功登出'}))
    response.delete_cookie('token')
    return response

@app.route('/api/auth/register', methods=['POST'])
def register():
    """用户注册"""
    # 检查系统是否允许注册
    allow_register = db.is_registration_allowed()
    logger.info(f"收到注册请求，当前注册功能状态: {allow_register}")

    if not allow_register:
        logger.warning("注册功能已禁用，拒绝注册请求")
        return jsonify({'error': '注册功能已禁用'}), 403

    data = request.json
    username = data.get('username')
    password = data.get('password')

    logger.info(f"注册用户名: {username}")

    if not username or not password:
        logger.warning("注册失败: 用户名或密码为空")
        return jsonify({'error': '用户名和密码不能为空'}), 400

    # 用户名格式验证
    if len(username) < 3 or len(username) > 20:
        logger.warning("注册失败: 用户名长度不符合要求")
        return jsonify({'error': '用户名长度必须在3-20个字符之间'}), 400

    # 密码强度验证
    if len(password) < 6:
        logger.warning("注册失败: 密码长度不符合要求")
        return jsonify({'error': '密码长度必须至少为6个字符'}), 400

    try:
        # 创建用户
        success, is_admin = db.create_user(username, password)
        if not success:
            logger.warning(f"注册失败: 用户名 {username} 已存在")
            return jsonify({'error': '用户名已存在'}), 409

        logger.info(f"注册成功: 用户名 {username}, 是否管理员: {is_admin}")
        return jsonify({
            'message': '注册成功',
            'username': username,
            'is_admin': is_admin,
            'note': '您是第一个注册的用户，已被自动设置为管理员' if is_admin else ''
        })
    except Exception as e:
        logger.error(f"注册过程出错: {str(e)}")
        return jsonify({'error': f'注册失败: {str(e)}'}), 500

@app.route('/api/auth/user', methods=['GET'])
@token_required
def get_current_user(current_user):
    """获取当前用户信息"""
    return jsonify({
        'id': current_user['id'],
        'username': current_user['username'],
        'is_admin': current_user['is_admin']
    })

@app.route('/api/auth/change-password', methods=['POST'])
@token_required
def change_password(current_user):
    """更改当前用户密码"""
    data = request.json
    old_password = data.get('old_password')
    new_password = data.get('new_password')

    if not old_password or not new_password:
        return jsonify({'error': '旧密码和新密码不能为空'}), 400

    # 验证旧密码
    user = db.authenticate_user(current_user['username'], old_password)
    if not user:
        return jsonify({'error': '旧密码不正确'}), 401

    # 密码强度验证
    if len(new_password) < 6:
        return jsonify({'error': '新密码长度必须至少为6个字符'}), 400

    # 更新密码
    success = db.update_user_password(current_user['id'], new_password)
    if not success:
        return jsonify({'error': '密码更新失败'}), 500

    return jsonify({'message': '密码已成功更新'})

# 用户管理API
@app.route('/api/users', methods=['GET'])
@token_required
@admin_required
def get_all_users(current_user):
    """获取所有用户 (仅管理员)"""
    users = db.get_all_users()
    return jsonify([dict(user) for user in users])

@app.route('/api/users', methods=['POST'])
@token_required
@admin_required
def create_user(current_user):
    """创建新用户 (仅管理员)"""
    data = request.json
    username = data.get('username')
    password = data.get('password')
    is_admin = data.get('is_admin', False)

    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400

    # 用户名格式验证
    if len(username) < 3 or len(username) > 20:
        return jsonify({'error': '用户名长度必须在3-20个字符之间'}), 400

    # 密码强度验证
    if len(password) < 6:
        return jsonify({'error': '密码长度必须至少为6个字符'}), 400

    # 创建用户
    success, _ = db.create_user(username, password, is_admin)
    if not success:
        return jsonify({'error': '用户名已存在'}), 409

    return jsonify({
        'message': '用户创建成功',
        'username': username,
        'is_admin': is_admin
    })

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@token_required
@admin_required
def delete_user(current_user, user_id):
    """删除用户 (仅管理员)"""
    # 检查是否是当前用户
    if user_id == current_user['id']:
        return jsonify({'error': '不能删除自己的账户'}), 400

    # 删除用户
    success = db.delete_user(user_id)
    if not success:
        return jsonify({'error': '删除用户失败'}), 500

    return jsonify({'message': f'用户ID {user_id} 已删除'})

@app.route('/api/users/<int:user_id>/reset-password', methods=['POST'])
@token_required
@admin_required
def reset_user_password(current_user, user_id):
    """重置用户密码 (仅管理员)"""
    data = request.json
    new_password = data.get('new_password')

    if not new_password:
        return jsonify({'error': '新密码不能为空'}), 400

    # 密码强度验证
    if len(new_password) < 6:
        return jsonify({'error': '新密码长度必须至少为6个字符'}), 400

    # 更新密码
    success = db.update_user_password(user_id, new_password)
    if not success:
        return jsonify({'error': '密码重置失败'}), 500

    return jsonify({'message': f'用户ID {user_id} 的密码已重置'})

# 修改现有API以加入用户认证和授权
@app.route('/api/health', methods=['GET'])
def health_check():
    """健康检查接口"""
    return jsonify({'status': 'ok', 'message': '花火邮箱助手服务正在运行'})

@app.route('/api/config', methods=['GET'])
def get_config():
    """获取系统配置"""
    try:
        # 确保从数据库获取最新的注册状态
        allow_register = db.is_registration_allowed()
        logger.info(f"获取系统配置: 注册功能状态 = {allow_register}")

        config = {
            'allow_register': allow_register,
            'server_time': datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }

        # 设置CORS头，确保前端可以正常访问
        response = jsonify(config)
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
        response.headers.add('Access-Control-Allow-Methods', 'GET')

        logger.info(f"返回系统配置: {config}")
        return response
    except Exception as e:
        logger.error(f"获取系统配置出错: {str(e)}")
        # 返回默认配置，确保注册功能默认开启
        default_config = {
            'allow_register': True,
            'server_time': datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            'error': f"配置获取错误: {str(e)}"
        }
        response = jsonify(default_config)
        response.headers.add('Access-Control-Allow-Origin', '*')
        return response

@app.route('/api/emails', methods=['GET'])
@token_required
def get_all_emails(current_user):
    """获取当前用户的所有邮箱"""
    # 普通用户只能获取自己的邮箱，管理员可以获取所有邮箱
    if current_user['is_admin']:
        emails = db.get_all_emails()
    else:
        emails = db.get_all_emails(current_user['id'])

    return jsonify([dict(email) for email in emails])

@app.route('/api/emails', methods=['POST'])
@token_required
def add_email(current_user):
    """添加新邮箱"""
    data = request.json
    email = data.get('email')
    password = data.get('password')
    mail_type = data.get('mail_type', 'outlook')

    if not email or not password:
        return jsonify({'error': '邮箱地址和密码是必需的'}), 400

    # 根据不同邮箱类型验证参数并添加
    if mail_type == 'outlook':
        client_id = data.get('client_id')
        refresh_token = data.get('refresh_token')

        if not client_id or not refresh_token:
            return jsonify({'error': 'Outlook邮箱需要提供Client ID和Refresh Token'}), 400

        success = db.add_email(
            current_user['id'],
            email,
            password,
            client_id,
            refresh_token,
            mail_type
        )
    elif mail_type in ['imap', 'gmail', 'qq']:
        # Gmail和QQ邮箱使用IMAP协议，服务器和端口是固定的
        if mail_type == 'gmail':
            server = 'imap.gmail.com'
            port = 993
        elif mail_type == 'qq':
            server = 'imap.qq.com'
            port = 993
        else:
            server = data.get('server', 'imap.gmail.com')
            port = data.get('port', 993)

        success = db.add_email(
            current_user['id'],
            email,
            password,
            mail_type=mail_type,
            server=server,
            port=port,
            use_ssl=True
        )
    else:
        return jsonify({'error': f'不支持的邮箱类型: {mail_type}'}), 400

    if success:
        return jsonify({'message': f'邮箱 {email} 添加成功'})
    else:
        return jsonify({'error': f'邮箱 {email} 已存在或添加失败'}), 409

@app.route('/api/emails/<int:email_id>', methods=['DELETE'])
@token_required
def delete_email(current_user, email_id):
    """删除邮箱"""
    # 获取邮箱信息
    email_info = db.get_email_by_id(email_id, None if current_user['is_admin'] else current_user['id'])
    if not email_info:
        return jsonify({'error': f'邮箱ID {email_id} 不存在或您没有权限'}), 404

    # 停止正在处理的邮箱
    if email_processor.is_email_being_processed(email_id):
        email_processor.stop_processing(email_id)

    # 管理员可以删除任何邮箱，普通用户只能删除自己的邮箱
    db.delete_email(email_id, None if current_user['is_admin'] else current_user['id'])
    return jsonify({'message': f'邮箱 ID {email_id} 已删除'})

@app.route('/api/emails/batch_delete', methods=['POST'])
@token_required
def batch_delete_emails(current_user):
    """批量删除邮箱"""
    data = request.json
    email_ids = data.get('email_ids', [])

    if not email_ids:
        return jsonify({'error': '未提供邮箱ID'}), 400

    # 停止正在处理的邮箱
    for email_id in email_ids:
        if email_processor.is_email_being_processed(email_id):
            email_processor.stop_processing(email_id)

    # 管理员可以删除任何邮箱，普通用户只能删除自己的邮箱
    db.delete_emails(email_ids, None if current_user['is_admin'] else current_user['id'])
    return jsonify({'message': f'已删除 {len(email_ids)} 个邮箱'})

@app.route('/api/emails/<int:email_id>/check', methods=['POST'])
@token_required
def check_email(current_user, email_id):
    """检查指定邮箱的新邮件"""
    try:
        # 获取邮箱信息
        email_info = db.get_email_by_id(email_id)
        if not email_info:
            return jsonify({'error': '邮箱不存在'}), 404

        # 检查邮箱是否属于当前用户
        if email_info['user_id'] != current_user['id']:
            return jsonify({'error': '无权操作此邮箱'}), 403

        # 检查邮箱是否正在处理中
        if email_processor.is_email_being_processed(email_id):
            logger.info(f"邮箱 ID {email_id} 正在处理中，拒绝重复请求")
            return jsonify({
                'success': False,
                'message': '邮箱正在处理中，请稍后再试',
                'status': 'processing'
            }), 409

        # 创建进度回调
        def progress_callback(progress, message):
            logger.info(f"邮箱 ID {email_id} 处理进度: {progress}%, 消息: {message}")
            # 通过WebSocket发送进度更新
            try:
                # 使用日志记录进度，不尝试调用异步方法
                logger.info(f"向用户 {current_user['id']} 发送邮箱检查进度: {progress}%, {message}")
                # 这里应使用同步方式发送消息，但WSHandler.broadcast_to_user是异步方法
            except Exception as e:
                logger.error(f"发送进度更新失败: {str(e)}")

        # 提交任务到线程池
        future = email_processor.manual_thread_pool.submit(
            email_processor._check_email_task,
            email_info,
            progress_callback
        )

        # 等待任务完成
        result = future.result(timeout=300)  # 设置超时时间为5分钟

        # 记录任务完成
        logger.info(f"任务完成: {result}")

        return jsonify(result)

    except concurrent.futures.TimeoutError:
        logger.error(f"检查邮箱超时: {email_id}")
        return jsonify({
            'success': False,
            'message': '检查邮箱超时，请稍后再试'
        }), 408

    except Exception as e:
        logger.error(f"检查邮箱失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'检查邮箱失败: {str(e)}'
        }), 500

@app.route('/api/emails/batch_check', methods=['POST'])
@token_required
def batch_check_emails(current_user):
    """批量检查邮箱邮件"""
    data = request.json
    email_ids = data.get('email_ids', [])

    if not email_ids:
        # 如果没有提供 ID，则获取当前用户拥有的所有邮箱
        if current_user['is_admin']:
            emails = db.get_all_emails()
        else:
            emails = db.get_all_emails(current_user['id'])

        email_ids = [email['id'] for email in emails]
    else:
        # 如果提供了ID，验证用户权限
        if not current_user['is_admin']:
            # 获取该用户拥有的邮箱
            owned_emails = db.get_all_emails(current_user['id'])
            owned_ids = [email['id'] for email in owned_emails]
            # 过滤出用户有权限的邮箱ID
            email_ids = [id for id in email_ids if id in owned_ids]

    if not email_ids:
        logger.warning(f"批量检查邮件：未找到邮箱 (用户ID: {current_user['id']})")
        return jsonify({'error': '没有找到邮箱或您没有权限'}), 404

    # 过滤掉已经在处理的邮箱ID
    processing_ids = []
    valid_ids = []
    for email_id in email_ids:
        if email_processor.is_email_being_processed(email_id):
            processing_ids.append(email_id)
        else:
            valid_ids.append(email_id)

    if processing_ids:
        logger.info(f"批量检查：跳过正在处理的邮箱IDs: {processing_ids}")

    if not valid_ids:
        logger.warning("批量检查邮件：所有选择的邮箱都在处理中")
        return jsonify({
            'message': '所有选择的邮箱都在处理中',
            'processing_ids': processing_ids
        }), 409

    # 记录有效的邮箱ID
    valid_emails = [db.get_email_by_id(email_id)['email'] for email_id in valid_ids if db.get_email_by_id(email_id)]
    logger.info(f"批量检查开始处理 {len(valid_ids)} 个邮箱: {valid_emails} (用户ID: {current_user['id']})")

    # 自定义进度回调
    def progress_callback(email_id, progress, message):
        logger.info(f"邮箱 ID {email_id} 处理进度: {progress}%, 消息: {message}")

    # 启动邮件检查线程
    email_processor.check_emails(valid_ids, progress_callback)

    return jsonify({
        'message': f'开始检查 {len(valid_ids)} 个邮箱',
        'skipped': len(processing_ids),
        'total': len(email_ids)
    })

@app.route('/api/emails/<int:email_id>/mail_records', methods=['GET'])
@token_required
def get_mail_records(current_user, email_id):
    """获取指定邮箱的邮件记录"""
    # 获取邮箱信息
    email_info = db.get_email_by_id(email_id, None if current_user['is_admin'] else current_user['id'])
    if not email_info:
        return jsonify({'error': f'邮箱 ID {email_id} 不存在或您没有权限'}), 404

    mail_records = db.get_mail_records(email_id)
    return jsonify([dict(record) for record in mail_records])

@app.route('/api/mail_records/<int:mail_id>/attachments', methods=['GET'])
@token_required
def get_mail_attachments(current_user, mail_id):
    """获取指定邮件的附件列表"""
    try:
        # 先获取邮件信息，验证权限
        mail_record = db.get_mail_record_by_id(mail_id)
        if not mail_record:
            return jsonify({'error': '邮件不存在'}), 404

        # 验证用户是否有权限访问该邮件
        email_id = mail_record['email_id']
        email_info = db.get_email_by_id(email_id, None if current_user['is_admin'] else current_user['id'])
        if not email_info:
            return jsonify({'error': '无权访问此邮件'}), 403

        # 获取附件列表
        attachments = db.get_attachments(mail_id)
        return jsonify([dict(attachment) for attachment in attachments])
    except Exception as e:
        logger.error(f"获取附件列表失败: {str(e)}")
        return jsonify({'error': f'服务器错误: {str(e)}'}), 500

@app.route('/api/attachments/<int:attachment_id>/download', methods=['GET'])
@token_required
def download_attachment(current_user, attachment_id):
    """下载附件"""
    try:
        # 获取附件信息
        attachment = db.get_attachment(attachment_id)
        if not attachment:
            return jsonify({'error': '附件不存在'}), 404

        # 验证用户是否有权限下载该附件
        mail_id = attachment['mail_id']
        mail_record = db.get_mail_record_by_id(mail_id)
        if not mail_record:
            return jsonify({'error': '邮件不存在'}), 404

        email_id = mail_record['email_id']
        email_info = db.get_email_by_id(email_id, None if current_user['is_admin'] else current_user['id'])
        if not email_info:
            return jsonify({'error': '无权下载此附件'}), 403

        # 准备下载响应
        filename = attachment['filename']
        content_type = attachment['content_type']
        content = attachment['content']

        response = make_response(content)
        response.headers['Content-Type'] = content_type
        response.headers['Content-Disposition'] = f'attachment; filename="{filename}"'

        return response
    except Exception as e:
        logger.error(f"下载附件失败: {str(e)}")
        return jsonify({'error': f'服务器错误: {str(e)}'}), 500

@app.route('/api/emails/<int:email_id>/upload_email_file', methods=['POST'])
@token_required
def upload_email_file(current_user, email_id):
    """上传邮件文件并解析"""
    try:
        # 验证用户是否有权限操作该邮箱
        email_info = db.get_email_by_id(email_id, None if current_user['is_admin'] else current_user['id'])
        if not email_info:
            return jsonify({'error': f'邮箱 ID {email_id} 不存在或您没有权限'}), 404

        # 检查是否有文件上传
        if 'file' not in request.files:
            return jsonify({'error': '没有上传文件'}), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': '没有选择文件'}), 400

        # 检查文件扩展名
        allowed_extensions = ['.eml', '.txt', '.msg', '.mbox', '.emlx']
        file_ext = os.path.splitext(file.filename)[1].lower()
        if file_ext not in allowed_extensions:
            return jsonify({'error': f'不支持的文件格式，仅支持 {", ".join(allowed_extensions)}'}), 400

        # 保存文件到临时目录
        temp_dir = os.path.join(os.getcwd(), 'temp')
        os.makedirs(temp_dir, exist_ok=True)
        temp_file_path = os.path.join(temp_dir, f"{int(time.time())}_{file.filename}")
        file.save(temp_file_path)

        try:
            # 导入邮件处理模块
            from utils.email import EmailFileParser

            # 解析邮件文件
            mail_record = EmailFileParser.parse_email_file(temp_file_path)

            if not mail_record:
                return jsonify({'error': '解析邮件文件失败'}), 400

            # 保存邮件记录到数据库
            success, mail_id = db.add_mail_record(
                email_id=email_id,
                subject=mail_record.get('subject', '(无主题)'),
                sender=mail_record.get('sender', '(未知发件人)'),
                content=mail_record.get('content', '(无内容)'),
                received_time=mail_record.get('received_time', datetime.now()),
                folder='IMPORTED',
                has_attachments=1 if mail_record.get('has_attachments', False) else 0
            )

            if success and mail_id and mail_record.get('has_attachments', False):
                # 保存附件
                attachments = mail_record.get('full_attachments', [])
                for attachment in attachments:
                    db.add_attachment(
                        mail_id=mail_id,
                        filename=attachment.get('filename', '未命名'),
                        content_type=attachment.get('content_type', 'application/octet-stream'),
                        size=attachment.get('size', 0),
                        content=attachment.get('content', b'')
                    )

            # 删除临时文件
            os.remove(temp_file_path)

            return jsonify({
                'success': True,
                'message': '邮件文件解析成功',
                'mail_id': mail_id
            })

        finally:
            # 确保临时文件被删除
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)

    except Exception as e:
        logger.error(f"上传邮件文件失败: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': f'服务器错误: {str(e)}'}), 500

@app.route('/api/emails/import', methods=['POST'])
@token_required
def import_emails(current_user):
    """批量导入邮箱"""
    data = request.json.get('data')
    mail_type = request.json.get('mail_type', 'outlook')

    if not data:
        return jsonify({'error': '导入数据不能为空'}), 400

    # 解析导入的数据
    lines = data.strip().split('\n')
    total = len(lines)
    success_count = 0
    failed_details = []

    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue

        try:
            parts = line.split('----')
            if len(parts) != 4:
                failed_details.append({
                    'line': i + 1,
                    'content': line,
                    'reason': '格式错误，需要4个字段'
                })
                continue

            email, password, client_id, refresh_token = parts
            if not all([email, password, client_id, refresh_token]):
                failed_details.append({
                    'line': i + 1,
                    'content': line,
                    'reason': '有空白字段'
                })
                continue

            success = db.add_email(current_user['id'], email, password, client_id, refresh_token, mail_type)
            if success:
                success_count += 1
            else:
                failed_details.append({
                    'line': i + 1,
                    'content': line,
                    'reason': '邮箱地址已存在'
                })
        except Exception as e:
            logger.error(f"导入邮箱出错: {str(e)}")
            failed_details.append({
                'line': i + 1,
                'content': line,
                'reason': f'导入异常: {str(e)}'
            })

    # 返回导入结果
    return jsonify({
        'total': total,
        'success': success_count,
        'failed': len(failed_details),
        'failed_details': failed_details
    })

# 系统配置管理
@app.route('/api/admin/config/registration', methods=['POST'])
@token_required
@admin_required
def toggle_registration(current_user):
    """管理员开启/关闭注册功能"""
    data = request.json
    allow = data.get('allow', False)

    if db.toggle_registration(allow):
        action = "开启" if allow else "关闭"
        logger.info(f"管理员 {current_user['username']} 已{action}注册功能")
        return jsonify({'message': f'已成功{action}注册功能', 'allow_register': allow})
    else:
        return jsonify({'error': '更新注册配置失败'}), 500

# 前端静态文件服务
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    """提供前端静态文件"""
    # 确定前端构建目录的路径
    frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'frontend', 'dist')

    # 如果路径为空或者是根路径，则返回 index.html
    if not path or path == '/':
        return send_from_directory(frontend_dir, 'index.html')

    # 检查请求的文件是否存在
    file_path = os.path.join(frontend_dir, path)
    if os.path.isfile(file_path):
        return send_from_directory(frontend_dir, path)
    else:
        # 如果文件不存在，返回 index.html 让前端路由处理
        return send_from_directory(frontend_dir, 'index.html')

@app.route('/api/emails/<int:email_id>/password', methods=['GET'])
@token_required
def get_email_password(current_user, email_id):
    """获取指定邮箱的密码"""
    try:
        email = db.get_email_by_id(email_id)
        if not email:
            return jsonify({'error': '邮箱不存在'}), 404

        # 验证是否为当前用户的邮箱或管理员
        if email['user_id'] != current_user['id'] and not current_user['is_admin']:
            return jsonify({'error': '无权访问此邮箱'}), 403

        return jsonify({'password': email['password']})
    except Exception as e:
        logger.error(f"获取邮箱密码失败: {str(e)}")
        return jsonify({'error': f'服务器错误: {str(e)}'}), 500

@app.route('/api/search', methods=['POST'])
@token_required
def search_emails(current_user):
    """搜索邮件内容"""
    try:
        data = request.json
        if not data:
            return jsonify({'error': '无效的请求数据格式'}), 400

        query = data.get('query', '').strip()
        search_in = data.get('search_in', [])  # 可以包含 'subject', 'sender', 'recipient', 'content'

        if not query:
            return jsonify({'error': '搜索关键词不能为空'}), 400

        if not search_in:
            search_in = ['subject', 'sender', 'recipient', 'content']  # 默认搜索所有字段

        logger.info(f"用户 {current_user['username']} 执行搜索: {query}, 搜索范围: {search_in}")

        # 获取用户的所有邮箱
        user_emails = db.get_emails_by_user_id(current_user['id'])
        user_email_ids = [email['id'] for email in user_emails]

        # 根据搜索条件查询邮件
        results = db.search_mail_records(
            user_email_ids,
            query,
            search_in_subject='subject' in search_in,
            search_in_sender='sender' in search_in,
            search_in_recipient='recipient' in search_in,
            search_in_content='content' in search_in
        )

        # 增加邮箱信息到结果中
        emails_map = {email['id']: email for email in user_emails}
        for record in results:
            email_id = record.get('email_id')
            if email_id in emails_map:
                record['email_address'] = emails_map[email_id]['email']

        return jsonify({'results': results})
    except Exception as e:
        logger.error(f"搜索邮件失败: {str(e)}")
        return jsonify({'error': f'服务器错误: {str(e)}'}), 500

@app.route('/api/emails/<int:email_id>', methods=['PUT'])
@token_required
def update_email(current_user, email_id):
    """更新邮箱信息"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': '无效的请求数据'}), 400

        # 获取当前邮箱信息，用于保留不允许修改的字段
        current_email = db.get_email_by_id(email_id, current_user['id'])
        if not current_email:
            return jsonify({'error': '邮箱不存在或您没有权限修改'}), 404

        # 验证邮箱信息
        required_fields = ['email', 'password']
        for field in required_fields:
            if field not in data and field != 'password':  # 密码可以不修改
                return jsonify({'error': f'缺少必要字段: {field}'}), 400

        # 准备更新数据，保持邮箱类型不变
        update_data = {
            'email': data.get('email'),
            'mail_type': current_email['mail_type']  # 使用已有数据，不允许修改
        }

        # 仅当提供了非空密码时才更新密码
        if data.get('password') and data.get('password') != '******':
            update_data['password'] = data.get('password')

        # 根据不同邮箱类型更新特定字段
        if current_email['mail_type'] == 'outlook':
            if data.get('client_id'):
                update_data['client_id'] = data.get('client_id')
            if data.get('refresh_token'):
                update_data['refresh_token'] = data.get('refresh_token')
        elif current_email['mail_type'] in ['imap', 'gmail', 'qq']:
            if data.get('server'):
                update_data['server'] = data.get('server')
            if data.get('port') is not None:
                update_data['port'] = data.get('port')
            if data.get('use_ssl') is not None:
                update_data['use_ssl'] = data.get('use_ssl')

        # 更新邮箱信息
        success = db.update_email(
            email_id,
            user_id=current_user['id'],
            **update_data
        )

        if not success:
            return jsonify({'error': '更新邮箱信息失败'}), 500

        logger.info(f"用户 {current_user['username']} 更新了邮箱 ID: {email_id}")

        return jsonify({
            'message': '邮箱信息更新成功',
            'data': {
                'email_id': email_id,
                'email': update_data['email'],
                'mail_type': update_data['mail_type']
            }
        }), 200

    except Exception as e:
        logger.error(f"更新邮箱信息失败: {str(e)}")
        return jsonify({'error': '更新邮箱信息失败'}), 500

@app.route('/api/emails/<int:email_id>/reauthorize', methods=['POST'])
@token_required
def reauthorize_email(current_user, email_id):
    """Outlook邮箱重新授权"""
    try:
        email_info = db.get_email_by_id(
            email_id,
            None if current_user['is_admin'] else current_user['id']
        )
        if not email_info:
            return jsonify({'error': '邮箱不存在或您没有权限'}), 404

        if email_info.get('mail_type') != 'outlook':
            return jsonify({'error': '仅支持Outlook邮箱重新授权'}), 400

        client_id = email_info.get('client_id')
        if not client_id:
            return jsonify({'error': '缺少Client ID'}), 400

        device_info = OutlookMailHandler.start_device_code_flow(client_id)
        if not device_info:
            return jsonify({'error': '获取设备码失败'}), 502

        ws_handler.send_reauthorize_status(
            current_user['id'],
            email_id,
            'pending',
            user_code=device_info.get('user_code'),
            verification_uri=device_info.get('verification_uri'),
            message='等待用户授权'
        )

        def poll_task():
            logger.info(f"开始设备码轮询: email_id={email_id}, user_id={current_user['id']}")
            interval = device_info.get('interval', 5)
            device_code = device_info.get('device_code')
            if not device_code:
                logger.error(f"设备码缺失: email_id={email_id}")
                ws_handler.send_reauthorize_status(
                    current_user['id'],
                    email_id,
                    'error',
                    message='设备码缺失'
                )
                return

            try:
                poll_count = 0
                while True:
                    poll_count += 1
                    logger.debug(f"轮询第{poll_count}次: email_id={email_id}")
                    result = OutlookMailHandler.poll_device_code(device_code, client_id, interval)
                    status = result.get('status')
                    logger.info(f"轮询结果: email_id={email_id}, status={status}")

                    if status == 'pending':
                        interval = result.get('interval', interval)
                        time.sleep(interval)
                        continue

                    if status == 'success':
                        logger.info(f"设备码授权成功: email_id={email_id}")
                        tokens = result.get('tokens', {})
                        access_token = tokens.get('access_token')
                        refresh_token = tokens.get('refresh_token')
                        if not access_token or not refresh_token:
                            logger.error(f"授权响应缺少token: email_id={email_id}, has_access={bool(access_token)}, has_refresh={bool(refresh_token)}")
                            ws_handler.send_reauthorize_status(
                                current_user['id'],
                                email_id,
                                'error',
                                message='授权响应缺少refresh_token'
                            )
                            return

                        updated = db.update_email_token(
                            email_id,
                            access_token,
                            refresh_token=refresh_token
                        )
                        if not updated:
                            logger.error(f"更新token失败: email_id={email_id}")
                            ws_handler.send_reauthorize_status(
                                current_user['id'],
                                email_id,
                                'error',
                                message='刷新令牌更新失败'
                            )
                            return

                        logger.info(f"token更新成功，发送WebSocket通知: email_id={email_id}, user_id={current_user['id']}")
                        ws_handler.send_reauthorize_status(
                            current_user['id'],
                            email_id,
                            'success',
                            message='授权成功'
                        )
                        return

                    message = result.get('error_description') or result.get('message') or '授权失败'
                    logger.error(f"设备码授权失败: email_id={email_id}, message={message}")
                    ws_handler.send_reauthorize_status(
                        current_user['id'],
                        email_id,
                        'error',
                        message=message
                    )
                    return
            except Exception as e:
                logger.error(f"设备码轮询失败: email_id={email_id}, error={str(e)}")
                ws_handler.send_reauthorize_status(
                    current_user['id'],
                    email_id,
                    'error',
                    message='设备码轮询异常'
                )

        threading.Thread(target=poll_task, daemon=True).start()

        return jsonify({
            'email_id': email_id,
            'user_code': device_info.get('user_code'),
            'verification_uri': device_info.get('verification_uri'),
            'expires_in': device_info.get('expires_in'),
            'interval': device_info.get('interval'),
        })
    except Exception as e:
        logger.error(f"重新授权请求失败: {str(e)}")
        return jsonify({'error': '重新授权请求失败'}), 500

@app.route('/api/email/start_real_time_check', methods=['POST'])
@token_required
def start_real_time_check():
    """启动实时邮件检查"""
    try:
        check_interval = request.json.get('check_interval', 60)
        if check_interval < 30:  # 最小检查间隔为30秒
            check_interval = 30

        success = email_processor.start_real_time_check(check_interval)
        if success:
            return jsonify({
                'success': True,
                'message': f'实时邮件检查已启动，检查间隔: {check_interval}秒'
            })
        else:
            return jsonify({
                'success': False,
                'message': '实时邮件检查已在运行中'
            })
    except Exception as e:
        logger.error(f"启动实时邮件检查失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'启动实时邮件检查失败: {str(e)}'
        })

@app.route('/api/email/stop_real_time_check', methods=['POST'])
@token_required
def stop_real_time_check():
    """停止实时邮件检查"""
    try:
        success = email_processor.stop_real_time_check()
        if success:
            return jsonify({
                'success': True,
                'message': '实时邮件检查已停止'
            })
        else:
            return jsonify({
                'success': False,
                'message': '实时邮件检查未在运行'
            })
    except Exception as e:
        logger.error(f"停止实时邮件检查失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'停止实时邮件检查失败: {str(e)}'
        })

@app.route('/api/email/add_to_real_time_queue', methods=['POST'])
@token_required
def add_to_real_time_queue():
    """将邮箱添加到实时检查队列"""
    try:
        email_id = request.json.get('email_id')
        if not email_id:
            return jsonify({
                'success': False,
                'message': '缺少邮箱ID'
            })

        email_processor.add_to_real_time_queue(email_id)
        return jsonify({
            'success': True,
            'message': f'邮箱ID: {email_id} 已添加到实时检查队列'
        })
    except Exception as e:
        logger.error(f"添加邮箱到实时检查队列失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'添加邮箱到实时检查队列失败: {str(e)}'
        })

@app.route('/api/emails/<int:email_id>/realtime', methods=['POST'])
@token_required
def toggle_email_realtime_check(current_user, email_id):
    """开启/关闭指定邮箱的实时检查"""
    try:
        data = request.json
        enable = data.get('enable', False)

        # 获取当前邮箱信息
        email_info = db.get_email_by_id(email_id, current_user['id'])
        if not email_info:
            return jsonify({'error': '邮箱不存在或您没有权限'}), 404

        # 更新实时检查状态
        success = db.set_email_realtime_check(email_id, enable)
        if not success:
            return jsonify({'error': '更新实时检查状态失败'}), 500

        action = "开启" if enable else "关闭"
        logger.info(f"用户 {current_user['username']} {action}了邮箱 {email_info['email']} 的实时检查")

        return jsonify({
            'success': True,
            'message': f'已{action}邮箱的实时检查',
            'data': {
                'email_id': email_id,
                'email': email_info['email'],
                'enable_realtime_check': enable
            }
        })
    except Exception as e:
        logger.error(f"切换邮箱实时检查状态失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'切换邮箱实时检查状态失败: {str(e)}'
        }), 500

def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(description='花火邮箱助手')
    parser.add_argument('--host', default='0.0.0.0', help='主机地址')
    parser.add_argument('--port', type=int, default=5000, help='HTTP端口')
    parser.add_argument('--ws-port', type=int, default=8765, help='WebSocket端口')
    parser.add_argument('--debug', action='store_true', help='启用调试模式')
    return parser.parse_args()

def start_websocket_server():
    """启动WebSocket服务器"""
    try:
        logger.info("启动WebSocket服务器")
        ws_handler.run()
    except Exception as e:
        logger.error(f"WebSocket服务器异常: {e}")
        sys.exit(1)

if __name__ == '__main__':
    try:
        args = parse_args()

        # 设置WebSocket端口
        ws_handler.port = args.ws_port

        # 启动WebSocket服务器
        ws_thread = threading.Thread(target=start_websocket_server)
        ws_thread.daemon = True
        ws_thread.start()

        # 启动实时邮件检查
        email_processor.start_real_time_check(check_interval=60)
        logger.info("实时邮件检查已启动")

        # 启动Flask应用
        logger.info(f"花火邮箱助手启动于 http://{args.host}:{args.port}")
        app.run(host=args.host, port=args.port, debug=args.debug)
    except KeyboardInterrupt:
        logger.info("程序被用户中断，正在关闭...")
    except Exception as e:
        logger.error(f"程序启动异常: {e}")
    finally:
        # 清理资源
        if db:
            db.close()
        logger.info("程序已关闭")
