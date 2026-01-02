"""
Outlook邮件处理模块
"""

import imaplib
import email
import requests
import time

from .common import (
    decode_mime_words,
    normalize_check_time,
    format_date_for_imap_search,
)
from .logger import logger

class OutlookMailHandler:
    """Outlook邮箱处理类"""

    # Outlook常用文件夹映射
    DEFAULT_FOLDERS = {
        'INBOX': ['inbox', 'Inbox', 'INBOX'],
        'SENT': ['sentitems', 'Sent Items', 'Sent', '已发送'],
        'DRAFTS': ['drafts', 'Drafts', '草稿箱'],
        'TRASH': ['deleteditems', 'Deleted Items', 'Trash', '已删除'],
        'SPAM': ['junkemail', 'Junk E-mail', 'Spam', '垃圾邮件'],
        'ARCHIVE': ['archive', 'Archive', '归档']
    }

    def __init__(self, email_address, access_token):
        """初始化Outlook处理器"""
        self.email_address = email_address
        self.access_token = access_token
        self.mail = None
        self.error = None

    def connect(self):
        """连接到Outlook服务器"""
        try:
            self.mail = imaplib.IMAP4_SSL('outlook.live.com')
            auth_string = OutlookMailHandler.generate_auth_string(self.email_address, self.access_token)
            self.mail.authenticate('XOAUTH2', lambda x: auth_string)
            return True
        except Exception as e:
            self.error = str(e)
            logger.error(f"Outlook连接失败: {e}")
            return False

    def get_folders(self):
        """获取文件夹列表"""
        if not self.mail:
            return []

        try:
            _, folders = self.mail.list()
            folder_list = []

            for folder in folders:
                if isinstance(folder, bytes):
                    folder = folder.decode('utf-8', errors='ignore')

                # 解析文件夹名称
                parts = folder.split('"')
                if len(parts) >= 3:
                    folder_name = parts[-2]
                else:
                    folder_name = folder.split()[-1]

                if folder_name and folder_name not in ['.', '..']:
                    folder_list.append(folder_name)

            # 确保常用文件夹在列表中
            default_folders = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail']
            for df in default_folders:
                if df not in folder_list:
                    folder_list.append(df)

            return sorted(folder_list)
        except Exception as e:
            logger.error(f"获取Outlook文件夹列表失败: {e}")
            return ['inbox']

    def get_messages(self, folder="inbox", limit=100):
        """获取指定文件夹的邮件"""
        if not self.mail:
            return []

        try:
            self.mail.select(folder)
            _, messages = self.mail.search(None, 'ALL')
            message_numbers = messages[0].split()

            # 限制数量并倒序（最新的在前）
            message_numbers = message_numbers[-limit:] if len(message_numbers) > limit else message_numbers
            message_numbers.reverse()

            mail_list = []
            for num in message_numbers:
                try:
                    _, msg_data = self.mail.fetch(num, '(RFC822)')
                    email_body = msg_data[0][1]
                    msg = email.message_from_bytes(email_body)

                    # 简化的邮件解析
                    subject = decode_mime_words(msg.get('Subject', ''))
                    sender = decode_mime_words(msg.get('From', ''))
                    received_time = email.utils.parsedate_to_datetime(msg.get('Date', ''))

                    # 获取邮件内容
                    content = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            content_type = part.get_content_type()
                            if content_type in ['text/plain', 'text/html']:
                                try:
                                    part_content = part.get_payload(decode=True).decode()
                                    content += part_content
                                except:
                                    pass
                    else:
                        try:
                            content = msg.get_payload(decode=True).decode()
                        except:
                            content = str(msg.get_payload())

                    mail_list.append({
                        'subject': subject,
                        'sender': sender,
                        'received_time': received_time,
                        'content': content,
                        'folder': folder
                    })
                except Exception as e:
                    logger.warning(f"解析Outlook邮件失败: {e}")
                    continue

            return mail_list
        except Exception as e:
            logger.error(f"获取Outlook邮件失败: {e}")
            return []

    def close(self):
        """关闭连接"""
        if self.mail:
            try:
                self.mail.logout()
            except:
                pass
            self.mail = None

    @staticmethod
    def get_new_access_token(refresh_token, client_id):
        """刷新获取新的access_token"""
        url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
        data = {
            'client_id': client_id,
            'grant_type': 'refresh_token',
            'refresh_token': refresh_token,
        }
        try:
            response = requests.post(url, data=data)
            payload = response.json()
            result_status = payload.get('error')
            if result_status is not None:
                error_description = payload.get('error_description')
                if error_description:
                    logger.error(f"获取访问令牌失败: {result_status} - {error_description}")
                else:
                    logger.error(f"获取访问令牌失败: {result_status}")
                return None, None

            new_access_token = payload.get('access_token')
            if not new_access_token:
                logger.error("获取访问令牌失败: access_token为空")
                return None, None

            new_refresh_token = payload.get('refresh_token')
            logger.info("成功获取新的访问令牌")
            return new_access_token, new_refresh_token
        except Exception as e:
            logger.error(f"刷新令牌过程中发生异常: {str(e)}")
            return None, None

    @staticmethod
    def start_device_code_flow(client_id):
        """启动Device Code Flow并返回验证信息"""
        url = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode'
        data = {
            'client_id': client_id,
            'scope': 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All',
        }
        try:
            response = requests.post(url, data=data)
            payload = response.json()
            error = payload.get('error')
            if error:
                error_description = payload.get('error_description')
                if error_description:
                    logger.error(f"设备码请求失败: {error} - {error_description}")
                else:
                    logger.error(f"设备码请求失败: {error}")
                return None

            required_fields = ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval']
            missing_fields = [field for field in required_fields if field not in payload]
            if missing_fields:
                logger.error(f"设备码响应缺少字段: {', '.join(missing_fields)}")
                return None

            return {field: payload[field] for field in required_fields}
        except Exception as e:
            logger.error(f"请求设备码过程中发生异常: {str(e)}")
            return None

    @staticmethod
    def poll_device_code(device_code, client_id, interval):
        """轮询Device Code Flow状态"""
        url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
        data = {
            'client_id': client_id,
            'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
            'device_code': device_code,
        }
        try:
            response = requests.post(url, data=data)
            payload = response.json()
            error = payload.get('error')
            if error:
                error_description = payload.get('error_description')
                if error == 'authorization_pending':
                    return {
                        'status': 'pending',
                        'message': error,
                        'interval': interval,
                    }
                if error == 'slow_down':
                    return {
                        'status': 'pending',
                        'message': error,
                        'interval': interval + 5,
                    }
                if error == 'expired_token':
                    logger.error("设备码已过期")
                    return {
                        'status': 'error',
                        'message': error,
                    }

                if error_description:
                    logger.error(f"设备码轮询失败: {error} - {error_description}")
                else:
                    logger.error(f"设备码轮询失败: {error}")
                return {
                    'status': 'error',
                    'message': error,
                    'error_description': error_description,
                }

            access_token = payload.get('access_token')
            if not access_token:
                logger.error("设备码授权成功但access_token为空")
                return {
                    'status': 'error',
                    'message': 'invalid_response',
                }

            return {
                'status': 'success',
                'tokens': payload,
            }
        except Exception as e:
            logger.error(f"轮询设备码过程中发生异常: {str(e)}")
            return {
                'status': 'error',
                'message': str(e),
            }

    @staticmethod
    def generate_auth_string(user, token):
        """生成 OAuth2 授权字符串"""
        return f"user={user}\1auth=Bearer {token}\1\1"

    @staticmethod
    def fetch_emails(email_address, access_token, folder="inbox", callback=None, last_check_time=None):
        """
        通过IMAP协议获取Outlook/Hotmail邮箱中的邮件

        Args:
            email_address: 邮箱地址
            access_token: OAuth2访问令牌
            folder: 邮件文件夹，默认为收件箱
            callback: 进度回调函数
            last_check_time: 上次检查时间，如果提供，只获取该时间之后的邮件

        Returns:
            list: 邮件记录列表
        """
        mail_records = []

        # 确保回调函数存在
        if callback is None:
            callback = lambda progress, folder: None

        # 标准化处理last_check_time
        last_check_time = normalize_check_time(last_check_time)

        # 日志记录
        if last_check_time:
            logger.info(f"获取Outlook邮箱{email_address}中{folder}文件夹自{last_check_time.isoformat()}以来的新邮件")
        else:
            logger.info(f"获取Outlook邮箱{email_address}中{folder}文件夹的所有邮件")

        # 尝试连接次数
        max_retries = 3

        for retry in range(max_retries):
            try:
                logger.info(f"尝试连接Outlook邮箱 (尝试 {retry+1}/{max_retries})")
                callback(10, folder)

                # 创建IMAP连接
                mail = imaplib.IMAP4_SSL('outlook.live.com')

                # 使用OAuth2登录
                auth_string = OutlookMailHandler.generate_auth_string(email_address, access_token)
                mail.authenticate('XOAUTH2', lambda x: auth_string)

                # 选择文件夹
                mail.select('inbox')
                callback(20, folder)

                # 定义搜索条件
                if last_check_time:
                    # 将上次检查时间转换为IMAP日期格式 (DD-MMM-YYYY)
                    search_date = format_date_for_imap_search(last_check_time)
                    search_cmd = f'(SINCE "{search_date}")'
                    logger.info(f"搜索{search_date}之后的邮件")
                    status, data = mail.search(None, search_cmd)
                else:
                    # 获取最近的100封邮件
                    status, data = mail.search(None, 'ALL')

                if status != 'OK':
                    logger.error(f"搜索邮件失败: {status}")
                    continue

                # 获取所有邮件ID
                mail_ids = data[0].split()

                # 只处理最近的100封邮件
                mail_ids = mail_ids[-100:] if len(mail_ids) > 100 else mail_ids

                total_mails = len(mail_ids)
                logger.info(f"找到{total_mails}封邮件")

                # 处理每封邮件
                for i, mail_id in enumerate(mail_ids):
                    # 更新进度
                    progress = int(20 + (i / total_mails) * 70) if total_mails > 0 else 90
                    callback(progress, folder)

                    try:
                        # 获取邮件
                        status, mail_data = mail.fetch(mail_id, '(RFC822)')

                        if status != 'OK':
                            logger.error(f"获取邮件ID {mail_id} 失败: {status}")
                            continue

                        # 解析邮件
                        msg = email.message_from_bytes(mail_data[0][1])

                        # 获取邮件基本信息
                        subject = decode_mime_words(msg.get('Subject', ''))
                        sender = decode_mime_words(msg.get('From', ''))
                        received_time = email.utils.parsedate_to_datetime(msg.get('Date', ''))

                        # 创建唯一标识，用于去重
                        mail_key = f"{subject}|{sender}|{received_time.isoformat() if received_time else 'unknown'}"

                        # 检查此邮件是否已处理（通过内存中的集合进行快速检查）
                        if mail_key in [record.get('mail_key') for record in mail_records]:
                            logger.info(f"跳过重复邮件: {subject}")
                            continue

                        # 获取邮件内容
                        content = ""
                        if msg.is_multipart():
                            for part in msg.walk():
                                content_type = part.get_content_type()
                                if content_type == 'text/plain' or content_type == 'text/html':
                                    try:
                                        part_content = part.get_payload(decode=True).decode()
                                        content += part_content
                                    except:
                                        pass
                        else:
                            content = msg.get_payload(decode=True).decode()

                        # 添加到结果列表
                        mail_records.append({
                            'subject': subject,
                            'sender': sender,
                            'received_time': received_time,
                            'content': content,
                            'mail_key': mail_key  # 添加唯一标识，用于后续去重
                        })

                    except Exception as e:
                        logger.error(f"处理邮件ID {mail_id} 时出错: {str(e)}")

                # 成功获取邮件，跳出重试循环
                callback(90, folder)
                break

            except imaplib.IMAP4.error as e:
                logger.error(f"IMAP错误: {str(e)}")
                time.sleep(1)  # 等待一秒再重试

            except Exception as e:
                logger.error(f"获取邮件异常: {str(e)}")
                time.sleep(1)  # 等待一秒再重试

            finally:
                # 确保关闭连接
                try:
                    mail.logout()
                except:
                    pass

        return mail_records

    @staticmethod
    def check_mail(email_info, db, progress_callback=None):
        """检查Outlook/Hotmail邮箱中的邮件并存储到数据库"""
        email_id = email_info['id']
        email_address = email_info['email']
        refresh_token = email_info['refresh_token']
        client_id = email_info['client_id']

        logger.info(f"开始检查Outlook邮箱: ID={email_id}, 邮箱={email_address}")

        # 确保回调函数存在
        if progress_callback is None:
            progress_callback = lambda progress, message: None

        # 报告初始进度
        progress_callback(0, "正在获取访问令牌...")

        try:
            # 获取新的访问令牌
            access_token, new_refresh_token = OutlookMailHandler.get_new_access_token(refresh_token, client_id)
            if not access_token:
                error_msg = f"邮箱{email_address}(ID={email_id})获取访问令牌失败"
                logger.error(error_msg)
                progress_callback(0, error_msg)
                return {
                    'success': False,
                    'message': error_msg
                }

            # 更新令牌到数据库
            db.update_email_token(email_id, access_token, refresh_token=new_refresh_token)

            # 报告进度
            progress_callback(10, "开始获取邮件...")

            # 获取邮件
            def folder_progress_callback(progress, folder):
                msg = f"正在处理{folder}文件夹，进度{progress}%"
                # 将各文件夹的进度映射到总进度10-90%
                total_progress = 10 + int(progress * 0.8)
                progress_callback(total_progress, msg)

            try:
                mail_records = OutlookMailHandler.fetch_emails(
                    email_address,
                    access_token,
                    "inbox",
                    folder_progress_callback
                )

                # 报告进度
                count = len(mail_records)
                progress_callback(90, f"获取到{count}封邮件，正在保存...")

                # 将邮件记录保存到数据库
                saved_count = 0
                for record in mail_records:
                    try:
                        success = db.add_mail_record(
                            email_id,
                            record['subject'],
                            record['sender'],
                            record['received_time'],
                            record['content']
                        )
                        if success:
                            saved_count += 1
                    except Exception as e:
                        logger.error(f"保存邮件记录失败: {str(e)}")

                # 更新最后检查时间（只有在成功获取到邮件或没有新邮件时才更新）
                try:
                    if count >= 0:  # 确保邮件获取成功
                        db.update_check_time(email_id)
                        logger.info(f"已更新邮箱{email_address}(ID={email_id})的最后检查时间")
                    else:
                        logger.warning(f"邮件获取失败，不更新邮箱{email_address}(ID={email_id})的最后检查时间")
                except Exception as e:
                    logger.error(f"更新检查时间失败: {str(e)}")

                # 报告完成
                success_msg = f"完成，共处理{count}封邮件，新增{saved_count}封"
                progress_callback(100, success_msg)

                logger.info(f"邮箱{email_address}(ID={email_id})检查完成，获取到{count}封邮件，新增{saved_count}封")
                return {
                    'success': True,
                    'message': success_msg,
                    'total': count,
                    'saved': saved_count
                }

            except Exception as e:
                error_msg = f"检查邮件失败: {str(e)}"
                logger.error(f"邮箱{email_address}(ID={email_id}){error_msg}")
                progress_callback(0, error_msg)
                return {
                    'success': False,
                    'message': error_msg
                }

        except Exception as e:
            error_msg = f"处理邮箱过程中出错: {str(e)}"
            logger.error(f"邮箱{email_address}(ID={email_id}){error_msg}")
            progress_callback(0, error_msg)
            return {
                'success': False,
                'message': error_msg
            }
