import os
import json
import asyncio
import logging
import websockets
import jwt
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

# 配置日志
logger = logging.getLogger('websocket')

class WebSocketHandler:
    def __init__(self):
        self.db = None
        self.email_processor = None
        self.port = 8765
        self.loop = None
        self.clients = {}  # 连接的客户端 {websocket: user_id}
        self.user_sockets = {}  # 用户的连接 {user_id: set(websockets)}
        self.client_tokens = {}  # 存储客户端的认证信息
        self.client_handlers = {}  # 存储每个客户端的处理函数
        self.active_users = {}  # 用户ID -> websocket连接
        self.user_counters = {}  # 用户ID -> 连接数
        
        # JWT密钥，与app.py保持一致
        self.jwt_secret = os.environ.get('JWT_SECRET_KEY', 'huohuo_email_secret_key')
    
    def set_dependencies(self, db, email_processor):
        """设置依赖"""
        self.db = db
        self.email_processor = email_processor
        
        # 注册消息处理函数
        self.client_handlers = {
            'get_all_emails': self.handle_get_all_emails_message,
            'check_emails': self.handle_check_emails_message,
            'get_mail_records': self.handle_get_mail_records_message,
            'add_email': self.handle_add_email_message,
            'delete_emails': self.handle_delete_emails_message,
            'import_emails': self.handle_import_emails_message,
        }
    
    async def register_client(self, websocket, path):
        """注册新客户端连接"""
        try:
            # 等待认证消息
            auth_message = await websocket.recv()
            auth_data = json.loads(auth_message)
            
            # 验证token
            user_id = self.validate_token(auth_data.get('token'))
            if not user_id:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '无效的认证令牌，请重新登录'
                }))
                return
            
            # 注册客户端
            self.clients[websocket] = user_id
            
            # 注册认证状态
            self.client_tokens[websocket] = auth_data.get('token')
            
            # 注册用户的WebSocket连接
            if user_id not in self.user_sockets:
                self.user_sockets[user_id] = set()
            self.user_sockets[user_id].add(websocket)
            
            logger.info(f"WebSocket客户端已连接，用户ID: {user_id}")
            
            # 发送连接成功消息
            await websocket.send(json.dumps({
                'type': 'connection_established',
                'message': '连接已建立'
            }))
            
            # 处理来自客户端的消息
            await self.handle_messages(websocket, user_id)
        except Exception as e:
            logger.error(f"WebSocket连接处理异常: {str(e)}")
        finally:
            # 客户端断开连接
            await self.unregister_client(websocket)
    
    async def unregister_client(self, websocket):
        """注销客户端连接"""
        if websocket in self.clients:
            user_id = self.clients[websocket]
            logger.info(f"WebSocket客户端已断开连接，用户ID: {user_id}")
            
            # 从用户的连接集合中移除
            if user_id in self.user_sockets:
                self.user_sockets[user_id].discard(websocket)
                if not self.user_sockets[user_id]:
                    del self.user_sockets[user_id]
            
            # 从客户端字典中移除
            del self.clients[websocket]
            
            # 从认证令牌字典中移除
            if websocket in self.client_tokens:
                del self.client_tokens[websocket]
    
    def validate_token(self, token):
        """验证JWT令牌并提取用户ID"""
        if not token:
            return None
        
        try:
            # 解码JWT令牌
            data = jwt.decode(token, self.jwt_secret, algorithms=["HS256"])
            
            # 检查用户是否存在
            user = self.db.get_user_by_id(data['user_id'])
            if not user:
                return None
            
            return user['id']
        except jwt.ExpiredSignatureError:
            logger.warning("令牌已过期")
            return None
        except Exception as e:
            logger.error(f"令牌验证失败: {str(e)}")
            return None
    
    async def handle_messages(self, websocket, user_id):
        """处理从客户端接收的消息"""
        async for message in websocket:
            try:
                data = json.loads(message)
                message_type = data.get('type')
                
                # 根据消息类型处理
                if message_type == 'get_all_emails':
                    await self.handle_get_all_emails(websocket, user_id)
                elif message_type == 'check_emails':
                    await self.handle_check_emails(websocket, user_id, data)
                elif message_type == 'get_mail_records':
                    await self.handle_get_mail_records(websocket, user_id, data)
                elif message_type == 'add_email':
                    await self.handle_add_email(websocket, user_id, data)
                elif message_type == 'delete_emails':
                    await self.handle_delete_emails(websocket, user_id, data)
                elif message_type == 'import_emails':
                    await self.handle_import_emails(websocket, user_id, data)
                else:
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'message': f'未知消息类型: {message_type}'
                    }))
            except json.JSONDecodeError:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '无效的JSON消息'
                }))
            except Exception as e:
                logger.error(f"处理消息时出错: {str(e)}")
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': f'处理消息时出错: {str(e)}'
                }))
    
    async def handle_get_all_emails(self, websocket, user_id):
        """处理获取所有邮箱的请求"""
        try:
            # 获取用户信息
            user = self.db.get_user_by_id(user_id)
            if not user:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '用户不存在'
                }))
                return
            
            # 管理员可以获取所有邮箱，普通用户只能获取自己的邮箱
            is_admin = user['is_admin'] if 'is_admin' in user else False
            if is_admin:
                emails = self.db.get_all_emails()
            else:
                emails = self.db.get_all_emails(user_id)
            
            # 将邮箱记录转换为字典列表
            emails_list = [dict(email) for email in emails]
            
            # 发送响应
            await websocket.send(json.dumps({
                'type': 'emails_list',
                'data': emails_list
            }))
            
            logger.info(f"发送邮箱列表给用户ID: {user_id}")
        except Exception as e:
            logger.error(f"获取邮箱列表失败: {str(e)}")
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'获取邮箱列表失败: {str(e)}'
            }))
    
    async def handle_check_emails(self, websocket, user_id, data):
        """处理检查邮箱邮件的请求"""
        try:
            # 获取请求数据
            email_ids = data.get('email_ids', [])
            if not email_ids:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '未提供邮箱ID'
                }))
                return
            
            # 获取用户信息
            user = self.db.get_user_by_id(user_id)
            if not user:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '用户不存在'
                }))
                return
            
            # 验证邮箱所有权
            is_admin = user['is_admin'] if 'is_admin' in user else False
            if not is_admin:
                # 获取用户拥有的邮箱
                owned_emails = self.db.get_all_emails(user_id)
                owned_ids = [email['id'] for email in owned_emails]
                
                # 过滤出用户有权限的邮箱ID
                valid_ids = [id for id in email_ids if id in owned_ids]
                
                if not valid_ids:
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'message': '您没有权限检查任何指定的邮箱'
                    }))
                    return
                
                email_ids = valid_ids
            
            # 过滤已经在处理的邮箱
            processing_ids = []
            valid_ids = []
            
            for email_id in email_ids:
                if self.email_processor.is_email_being_processed(email_id):
                    processing_ids.append(email_id)
                else:
                    valid_ids.append(email_id)
            
            if processing_ids:
                await websocket.send(json.dumps({
                    'type': 'info',
                    'message': f'跳过已经在处理中的 {len(processing_ids)} 个邮箱'
                }))
            
            if not valid_ids:
                await websocket.send(json.dumps({
                    'type': 'warning',
                    'message': '所有邮箱都在处理中，请稍后再试'
                }))
                return
            
            # 定义详细的进度回调函数
            def progress_callback(email_id, progress, message):
                # 获取邮箱信息用于更详细的日志
                email_info = self.db.get_email_by_id(email_id)
                email_address = email_info['email'] if email_info else f"ID:{email_id}"
                
                # 记录进度日志
                if progress == 0:
                    logger.info(f"开始检查邮箱 {email_address}")
                elif progress == 100:
                    logger.info(f"完成检查邮箱 {email_address}")
                else:
                    logger.info(f"邮箱 {email_address} 检查进度: {progress}% - {message}")
                
                # 发送进度更新到WebSocket
                asyncio.run(self.send_progress_update(user_id, email_id, progress, message))
            
            # 启动检查邮箱任务
            with ThreadPoolExecutor() as executor:
                executor.submit(self.email_processor.check_emails, valid_ids, progress_callback)
            
            # 发送开始检查的消息
            await websocket.send(json.dumps({
                'type': 'success',
                'message': f'开始检查 {len(valid_ids)} 个邮箱'
            }))
            
            logger.info(f"开始检查邮箱: {valid_ids} (用户ID: {user_id})")
        except Exception as e:
            logger.error(f"检查邮箱失败: {str(e)}")
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'检查邮箱失败: {str(e)}'
            }))
    
    async def handle_get_mail_records(self, websocket, user_id, data):
        """处理获取邮件记录的请求"""
        try:
            # 获取请求数据
            email_id = data.get('email_id')
            if not email_id:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '未提供邮箱ID'
                }))
                return
            
            # 获取用户信息
            user = self.db.get_user_by_id(user_id)
            if not user:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '用户不存在'
                }))
                return
            
            # 验证邮箱所有权
            is_admin = user['is_admin'] if 'is_admin' in user else False
            email_info = self.db.get_email_by_id(email_id, None if is_admin else user_id)
            if not email_info:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': f'邮箱ID {email_id} 不存在或您没有权限'
                }))
                return
            
            # 获取邮件记录
            mail_records = self.db.get_mail_records(email_id)
            
            # 发送响应
            await websocket.send(json.dumps({
                'type': 'mail_records',
                'email_id': email_id,
                'data': [dict(record) for record in mail_records]
            }))
            
            logger.info(f"发送邮件记录给用户ID: {user_id}, 邮箱ID: {email_id}")
        except Exception as e:
            logger.error(f"获取邮件记录失败: {str(e)}")
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'获取邮件记录失败: {str(e)}'
            }))
    
    async def handle_add_email(self, websocket, user_id, data):
        """处理添加邮箱的请求"""
        try:
            # 获取请求数据
            email = data.get('email')
            password = data.get('password')
            mail_type = data.get('mail_type', 'imap')  # 默认使用imap类型
            client_id = data.get('client_id')
            refresh_token = data.get('refresh_token')
            server = data.get('server')
            port = data.get('port')
            use_ssl = data.get('use_ssl', True)
            
            if not email or not password:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '邮箱地址和密码不能为空'
                }))
                return
            
            # 根据不同邮箱类型处理
            if mail_type == 'outlook':
                if not client_id or not refresh_token:
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'message': 'Outlook邮箱需要提供Client ID和Refresh Token'
                    }))
                    return
                email_id = self.db.add_email(user_id, email, password, client_id, refresh_token, mail_type)
            else:  # imap类型
                email_id = self.db.add_email(
                    user_id, 
                    email, 
                    password, 
                    mail_type=mail_type,
                    server=server,
                    port=port,
                    use_ssl=use_ssl
                )
            
            if email_id:
                # 发送成功消息
                await websocket.send(json.dumps({
                    'type': 'email_added',
                    'message': f'邮箱 {email} 添加成功'
                }))
                
                logger.info(f"用户ID {user_id} 添加了邮箱: {email}, 类型: {mail_type}")
            else:
                # 发送错误消息
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': f'邮箱 {email} 添加失败，可能已存在'
                }))
        except Exception as e:
            logger.error(f"添加邮箱失败: {str(e)}")
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'添加邮箱失败: {str(e)}'
            }))
    
    async def handle_delete_emails(self, websocket, user_id, data):
        """处理删除邮箱的请求"""
        try:
            # 获取请求数据
            email_ids = data.get('email_ids', [])
            if not email_ids:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '未提供邮箱ID'
                }))
                return
            
            # 获取用户信息
            user = self.db.get_user_by_id(user_id)
            if not user:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '用户不存在'
                }))
                return
            
            # 验证邮箱所有权并删除
            is_admin = user['is_admin'] if 'is_admin' in user else False
            if is_admin:
                # 管理员可以删除任何邮箱
                self.db.delete_emails(email_ids)
            else:
                # 普通用户只能删除自己的邮箱
                self.db.delete_emails(email_ids, user_id)
            
            # 发送成功消息
            await websocket.send(json.dumps({
                'type': 'emails_deleted',
                'email_ids': email_ids,
                'message': f'已删除 {len(email_ids)} 个邮箱'
            }))
            
            # 向所有客户端广播邮箱已删除的消息
            await self.broadcast_emails_deleted(email_ids)
            
            logger.info(f"用户ID {user_id} 删除了邮箱: {email_ids}")
        except Exception as e:
            logger.error(f"删除邮箱失败: {str(e)}")
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'删除邮箱失败: {str(e)}'
            }))
    
    async def send_progress_update(self, user_id, email_id, progress, message):
        """发送进度更新给用户"""
        if user_id not in self.user_sockets:
            logger.warning(f"找不到用户ID: {user_id}的WebSocket连接，无法发送进度更新")
            return
        
        # 确保进度在0-100范围内
        progress = max(0, min(100, progress))
        
        # 构建进度消息
        progress_message = json.dumps({
            'type': 'check_progress',
            'email_id': email_id,
            'progress': progress,
            'message': message,
            'timestamp': datetime.now().isoformat()
        })
        
        # 发送给该用户的所有WebSocket连接
        websockets_copy = self.user_sockets[user_id].copy()
        success_count = 0
        
        for websocket in websockets_copy:
            try:
                await websocket.send(progress_message)
                success_count += 1
            except Exception as e:
                logger.error(f"向用户 {user_id} 发送进度更新失败: {str(e)}")
                # 这里不需要删除连接，因为错误会导致连接关闭，unregister_client会处理
        
        if success_count > 0:
            logger.debug(f"成功向用户 {user_id} 的 {success_count} 个连接发送进度更新: {email_id} - {progress}% - {message}")
    
    # 添加广播到特定用户的所有连接的方法
    async def broadcast_to_user(self, user_id, message):
        """向特定用户的所有连接广播消息"""
        if user_id not in self.user_sockets:
            logger.warning(f"找不到用户ID: {user_id}的WebSocket连接，无法发送消息")
            return
        
        # 将消息转换为JSON字符串
        message_str = json.dumps(message)
        
        # 发送给该用户的所有WebSocket连接
        websockets_copy = self.user_sockets[user_id].copy()
        success_count = 0
        
        for websocket in websockets_copy:
            try:
                await websocket.send(message_str)
                success_count += 1
            except Exception as e:
                logger.error(f"向用户 {user_id} 广播消息失败: {str(e)}")
                # 错误会由unregister_client处理
        
        if success_count > 0:
            logger.debug(f"成功向用户 {user_id} 的 {success_count} 个连接广播消息: {message['type']}")
        
        return success_count > 0

    def send_to_user_threadsafe(self, user_id, message):
        """线程安全地向指定用户发送消息"""
        if not self.loop:
            logger.warning("WebSocket事件循环未初始化，无法发送消息")
            return False

        future = asyncio.run_coroutine_threadsafe(
            self.broadcast_to_user(user_id, message),
            self.loop
        )
        try:
            return future.result(timeout=2)
        except Exception as e:
            logger.error(f"发送WebSocket消息失败: {str(e)}")
            return False

    def send_reauthorize_status(self, user_id, email_id, status, user_code=None, verification_uri=None, message=None):
        """发送设备码重新授权状态"""
        data = {
            'email_id': email_id,
            'status': status,
        }
        if user_code:
            data['user_code'] = user_code
        if verification_uri:
            data['verification_uri'] = verification_uri
        if message:
            data['message'] = message

        logger.info(f"发送重新授权状态: user_id={user_id}, email_id={email_id}, status={status}, message={message}")
        result = self.send_to_user_threadsafe(user_id, {
            'type': 'reauthorize_status',
            'data': data,
        })
        if result:
            logger.info(f"重新授权状态发送成功: user_id={user_id}, email_id={email_id}")
        else:
            logger.warning(f"重新授权状态发送失败: user_id={user_id}, email_id={email_id}")
        return result
    
    async def broadcast_emails_deleted(self, email_ids):
        """向所有连接的客户端广播邮箱已删除的消息"""
        message = json.dumps({
            'type': 'emails_deleted',
            'email_ids': email_ids
        })
        
        # 复制客户端字典，避免在迭代过程中修改
        clients_copy = list(self.clients.keys())
        for websocket in clients_copy:
            try:
                await websocket.send(message)
            except Exception as e:
                logger.error(f"广播邮箱删除消息失败: {str(e)}")
                # 这里不需要删除连接，因为错误会导致连接关闭，unregister_client会处理
    
    async def handle_import_emails(self, websocket, user_id, data):
        """处理导入邮箱的请求"""
        try:
            # 获取请求数据
            import_data = data.get('data', '')
            if not import_data:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '未提供要导入的邮箱数据'
                }))
                return
            
            # 获取用户信息
            user = self.db.get_user_by_id(user_id)
            if not user:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': '用户不存在'
                }))
                return
            
            # 处理导入邮箱的逻辑
            # 解析导入数据，预期格式: 一行一条，每条格式为 email----password----client_id----refresh_token
            lines = import_data.strip().split('\n')
            imported_count = 0
            errors = []
            
            for line in lines:
                try:
                    parts = line.strip().split('----')
                    
                    if len(parts) < 2:
                        errors.append(f"格式错误: {line}")
                        continue
                    
                    email = parts[0]
                    password = parts[1]
                    client_id = parts[2] if len(parts) > 2 else None
                    refresh_token = parts[3] if len(parts) > 3 else None
                    
                    # 添加邮箱到数据库 - 确保参数顺序正确：user_id, email, password, client_id, refresh_token
                    email_id = self.db.add_email(user_id, email, password, client_id, refresh_token)
                    if email_id:
                        imported_count += 1
                    else:
                        errors.append(f"添加失败: {email}")
                except Exception as e:
                    errors.append(f"处理失败: {line} ({str(e)})")
            
            # 发送导入结果消息
            if imported_count > 0:
                await websocket.send(json.dumps({
                    'type': 'success',
                    'message': f'成功导入 {imported_count} 个邮箱'
                }))
                
                # 广播邮箱列表更新
                await websocket.send(json.dumps({
                    'type': 'emails_imported'
                }))
            else:
                await websocket.send(json.dumps({
                    'type': 'warning',
                    'message': '没有成功导入任何邮箱'
                }))
            
            # 如果有错误，也发送错误详情
            if errors:
                error_message = '\n'.join(errors[:10])
                if len(errors) > 10:
                    error_message += f"\n...以及其他 {len(errors) - 10} 个错误"
                
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': f'导入过程中出现以下错误:\n{error_message}'
                }))
            
            logger.info(f"用户ID {user_id} 完成邮箱批量导入，成功: {imported_count}，失败: {len(errors)}")
        except Exception as e:
            logger.error(f"导入邮箱失败: {str(e)}")
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'导入邮箱失败: {str(e)}'
            }))
    
    async def handle_message(self, websocket, message_text):
        """处理WebSocket消息"""
        try:
            message = json.loads(message_text)
            message_type = message.get('type')
            
            # 处理重复认证消息
            if message_type == 'authenticate':
                # 如果已经认证过，直接返回认证成功
                if websocket in self.client_tokens:
                    await self.send_message(websocket, {
                        'type': 'auth_result',
                        'success': True,
                        'message': '认证成功'
                    })
                    return
                else:
                    # 处理新认证请求
                    token = message.get('token')
                    if not token:
                        await self.send_error(websocket, "无效的认证消息")
                        return
                    
                    user_id = self.validate_token(token)
                    if not user_id:
                        await self.send_error(websocket, "无效的认证令牌，请重新登录")
                        return
                    
                    # 注册认证状态
                    self.client_tokens[websocket] = token
                    
                    # 发送认证成功消息
                    await self.send_message(websocket, {
                        'type': 'auth_result',
                        'success': True,
                        'message': '认证成功'
                    })
                    return
            
            # 未认证的客户端只能发送认证消息
            if websocket not in self.client_tokens and message_type != 'authenticate':
                await self.send_error(websocket, "请先进行认证")
                return
            
            # 心跳消息处理
            if message_type == 'heartbeat':
                await self.handle_heartbeat(websocket)
                return
            
            # 调用对应类型的处理函数
            handler = self.client_handlers.get(message_type)
            if handler:
                await handler(websocket, message)
            else:
                logger.warning(f"未知的消息类型: {message_type}")
                await self.send_error(websocket, f"未知的消息类型: {message_type}")
        except json.JSONDecodeError:
            logger.error("无效的JSON消息")
            await self.send_error(websocket, "无效的消息格式")
        except Exception as e:
            logger.error(f"处理消息时出错: {str(e)}")
            await self.send_error(websocket, f"处理消息失败: {str(e)}")
    
    async def handle_heartbeat(self, websocket):
        """处理心跳消息"""
        logger.debug("收到心跳消息，发送响应")
        await self.send_message(websocket, {
            'type': 'heartbeat_response',
            'timestamp': datetime.now().isoformat()
        })
    
    async def websocket_server(self, websocket, path):
        """WebSocket服务器入口点"""
        logger.info(f"新的WebSocket连接: {websocket.remote_address}")
        try:
            # 等待认证消息
            auth_message = await websocket.recv()
            auth_data = json.loads(auth_message)
            
            if auth_data.get('type') == 'heartbeat':
                # 处理心跳消息
                await self.handle_heartbeat(websocket)
                return
            
            # 验证token
            token = auth_data.get('token')
            if not token or auth_data.get('type') != 'authenticate':
                await self.send_error(websocket, "请发送有效的认证消息")
                return
            
            user_id = self.validate_token(token)
            if not user_id:
                await self.send_error(websocket, "无效的认证令牌，请重新登录")
                return
            
            # 注册客户端
            self.clients[websocket] = user_id
            
            # 注册认证状态
            self.client_tokens[websocket] = token
            
            # 注册用户的WebSocket连接
            if user_id not in self.user_sockets:
                self.user_sockets[user_id] = set()
            self.user_sockets[user_id].add(websocket)
            
            logger.info(f"WebSocket客户端已认证，用户ID: {user_id}")
            
            # 发送认证成功消息
            await self.send_message(websocket, {
                'type': 'auth_result',
                'success': True,
                'message': '认证成功'
            })
            
            # 处理来自客户端的消息
            try:
                async for message in websocket:
                    await self.handle_message(websocket, message)
            except websockets.exceptions.ConnectionClosed:
                logger.info(f"WebSocket连接已关闭: {websocket.remote_address}")
            
        except json.JSONDecodeError:
            await self.send_error(websocket, "无效的JSON消息")
        except Exception as e:
            logger.error(f"WebSocket处理异常: {str(e)}")
        finally:
            # 客户端断开连接
            await self.unregister_client(websocket)
    
    async def send_error(self, websocket, message):
        """发送错误消息"""
        try:
            await websocket.send(json.dumps({
                'type': 'error',
                'message': message
            }))
        except:
            pass
    
    async def send_message(self, websocket, message):
        """发送消息"""
        try:
            await websocket.send(json.dumps(message))
        except Exception as e:
            logger.error(f"发送消息失败: {str(e)}")
    
    def run(self):
        """启动WebSocket服务器"""
        # 创建事件循环
        loop = asyncio.new_event_loop()
        self.loop = loop
        asyncio.set_event_loop(loop)
        
        # 启动WebSocket服务器
        start_server = websockets.serve(
            self.websocket_server,
            "0.0.0.0",
            self.port
        )
        
        logger.info(f"WebSocket服务器启动于端口 {self.port}")
        
        # 运行事件循环
        loop.run_until_complete(start_server)
        loop.run_forever()

    async def handle_get_all_emails_message(self, websocket, message):
        """处理获取所有邮箱的WebSocket消息"""
        user_id = self.clients.get(websocket)
        if not user_id:
            await self.send_error(websocket, "未找到用户信息")
            return
        await self.handle_get_all_emails(websocket, user_id)
    
    async def handle_check_emails_message(self, websocket, message):
        """处理检查邮箱的WebSocket消息"""
        user_id = self.clients.get(websocket)
        if not user_id:
            await self.send_error(websocket, "未找到用户信息")
            return
        await self.handle_check_emails(websocket, user_id, message)
    
    async def handle_get_mail_records_message(self, websocket, message):
        """处理获取邮件记录的WebSocket消息"""
        user_id = self.clients.get(websocket)
        if not user_id:
            await self.send_error(websocket, "未找到用户信息")
            return
        await self.handle_get_mail_records(websocket, user_id, message)
    
    async def handle_add_email_message(self, websocket, message):
        """处理添加邮箱的WebSocket消息"""
        user_id = self.clients.get(websocket)
        if not user_id:
            await self.send_error(websocket, "未找到用户信息")
            return
        await self.handle_add_email(websocket, user_id, message)
    
    async def handle_delete_emails_message(self, websocket, message):
        """处理删除邮箱的WebSocket消息"""
        user_id = self.clients.get(websocket)
        if not user_id:
            await self.send_error(websocket, "未找到用户信息")
            return
        await self.handle_delete_emails(websocket, user_id, message)
    
    async def handle_import_emails_message(self, websocket, message):
        """处理导入邮箱的WebSocket消息"""
        user_id = self.clients.get(websocket)
        if not user_id:
            await self.send_error(websocket, "未找到用户信息")
            return
        await self.handle_import_emails(websocket, user_id, message) 
