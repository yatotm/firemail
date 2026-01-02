<template>
  <div class="page-container">
    <div class="emails-container">
      <el-card class="email-list-card shadow">
        <template #header>
          <div class="card-header flex-between">
            <h2 class="page-title">邮箱列表</h2>
            <div class="actions flex gap-md">
              <el-button type="primary" @click="refreshEmails" :icon="Refresh" class="hover-scale">
                刷新列表
              </el-button>
              <el-button type="success" @click="showAddEmailDialog" :icon="Plus" class="hover-scale">
                添加邮箱
              </el-button>
            </div>
          </div>
        </template>

        <div class="toolbar flex gap-md mb-4">
          <el-button
            type="danger"
            :disabled="!hasSelectedEmails"
            @click="handleBatchDelete"
            :icon="Delete"
            class="hover-scale"
          >
            批量删除
          </el-button>
          <el-button
            type="primary"
            :disabled="!hasSelectedEmails"
            @click="handleBatchCheck"
            :icon="Download"
            class="hover-scale"
          >
            批量收信
          </el-button>
        </div>

        <el-table
          v-loading="loading"
          :data="emails"
          @selection-change="handleSelectionChange"
          style="width: 100%"
          stripe
          border
          highlight-current-row
          class="email-table"
        >
          <el-table-column
            type="selection"
            width="55"
            :selectable="row => row"
          />
          <el-table-column prop="email" label="邮箱地址" width="220" />
          <el-table-column prop="mail_type" label="邮箱类型" width="120">
            <template #default="scope">
              <el-tag
                :type="getMailTypeColor(scope.row.mail_type || 'outlook')"
                effect="plain"
                class="mail-type-tag"
              >
                {{ getMailTypeName(scope.row.mail_type || 'outlook') }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="password" label="密码" width="150">
            <template #default="scope">
              <div class="password-field flex-between">
                <span class="password-text">{{ scope.row.showPassword ? scope.row.password : '******' }}</span>
                <el-button
                  type="primary"
                  link
                  :icon="scope.row.showPassword ? Hide : View"
                  @click="togglePasswordVisibility(scope.row)"
                  :loading="scope.row.passwordLoading"
                  class="password-toggle-btn"
                />
              </div>
            </template>
          </el-table-column>
          <el-table-column label="配置信息" width="200">
            <template #default="scope">
              <template v-if="scope.row.mail_type === 'imap'">
                <div class="server-info">
                  <div class="server-field">
                    <strong>服务器:</strong> {{ scope.row.server || 'N/A' }}
                  </div>
                  <div class="port-field">
                    <strong>端口:</strong> {{ scope.row.port || 'N/A' }}
                  </div>
                </div>
              </template>
              <template v-else-if="scope.row.mail_type === 'gmail'">
                <div class="config-info">
                  <div>服务器: imap.gmail.com</div>
                  <div>端口: 993</div>
                </div>
              </template>
              <template v-else-if="scope.row.mail_type === 'qq'">
                <div class="config-info">
                  <div>服务器: imap.qq.com</div>
                  <div>端口: 993</div>
                </div>
              </template>
              <template v-else>
                <div class="config-info">标准配置</div>
              </template>
            </template>
          </el-table-column>
          <el-table-column prop="last_check_time" label="最后检查时间" width="180">
            <template #default="scope">
              <span>{{ formatDate(scope.row.last_check_time) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="260">
            <template #default="scope">
              <div class="action-buttons">
                <el-button
                  type="primary"
                  size="small"
                  :disabled="isEmailProcessing(scope.row)"
                  @click="handleCheck(scope.row)"
                >
                  {{ getEmailActionText(scope.row) }}
                </el-button>
                <el-button
                  type="success"
                  size="small"
                  @click="handleViewMails(scope.row)"
                >
                  查看邮件
                </el-button>
                <el-dropdown trigger="click" @command="(cmd) => handleActionCommand(cmd, scope.row)">
                  <el-button size="small">
                    更多<el-icon class="el-icon--right"><ArrowDown /></el-icon>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="edit">编辑</el-dropdown-item>
                      <el-dropdown-item
                        v-if="scope.row.mail_type === 'outlook'"
                        command="reauthorize"
                      >
                        重新授权
                      </el-dropdown-item>
                      <el-dropdown-item command="delete" divided>
                        <span style="color: #f56c6c">删除</span>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 添加邮箱对话框 -->
      <el-dialog
        v-model="addEmailDialogVisible"
        title="添加邮箱"
        width="600px"
        :close-on-click-modal="false"
        class="add-email-dialog"
        destroy-on-close
      >
        <el-tabs v-model="addEmailActiveTab">
          <el-tab-pane label="单个添加" name="single">
            <el-form
              ref="addEmailFormRef"
              :model="addEmailForm"
              :rules="addEmailRules"
              label-width="120px"
              class="add-email-form"
            >
              <el-form-item label="邮箱类型" prop="mail_type">
                <el-select v-model="addEmailForm.mail_type" placeholder="请选择邮箱类型" class="w-full">
                  <el-option
                    v-for="(config, type) in mailTypes"
                    :key="type"
                    :label="config.name"
                    :value="type"
                  />
                </el-select>
              </el-form-item>

              <el-form-item label="邮箱地址" prop="email">
                <el-input v-model="addEmailForm.email" placeholder="请输入邮箱地址" />
              </el-form-item>

              <el-form-item label="密码" prop="password">
                <el-input
                  v-model="addEmailForm.password"
                  type="password"
                  placeholder="请输入密码"
                  show-password
                />
              </el-form-item>

              <template v-if="addEmailForm.mail_type === 'outlook'">
                <el-form-item label="Client ID" prop="client_id">
                  <el-input v-model="addEmailForm.client_id" placeholder="请输入Client ID" />
                </el-form-item>

                <el-form-item label="Refresh Token" prop="refresh_token">
                  <el-input v-model="addEmailForm.refresh_token" placeholder="请输入Refresh Token" />
                </el-form-item>
              </template>

              <template v-if="addEmailForm.mail_type === 'imap'">
                <el-form-item label="服务器" prop="server">
                  <el-input v-model="addEmailForm.server" placeholder="请输入IMAP服务器地址" />
                </el-form-item>

                <el-form-item label="端口" prop="port">
                  <el-input-number v-model="addEmailForm.port" :min="1" :max="65535" />
                </el-form-item>

                <el-form-item label="使用SSL" prop="use_ssl">
                  <el-switch v-model="addEmailForm.use_ssl" />
                </el-form-item>
              </template>
            </el-form>
          </el-tab-pane>

          <el-tab-pane label="批量添加" name="batch">
            <p class="import-help">请按照以下格式输入邮箱信息，每行一个：<br/>邮箱地址----密码----客户端ID----刷新令牌</p>
            <el-form :model="batchImport" label-width="120px" :rules="batchImportRules" ref="batchImportFormRef">
              <el-form-item label="邮箱类型">
                <el-select v-model="batchImport.mailType" placeholder="请选择邮箱类型">
                  <el-option
                    label="Outlook/Hotmail"
                    value="outlook"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="批量数据" prop="data">
                <el-input
                  v-model="batchImport.data"
                  type="textarea"
                  :rows="10"
                  placeholder="例如: example@outlook.com----password----clientid----refreshtoken"
                />
              </el-form-item>
            </el-form>
          </el-tab-pane>
        </el-tabs>

        <template #footer>
          <span class="dialog-footer">
            <el-button @click="addEmailDialogVisible = false">取消</el-button>
            <el-button type="primary" @click="handleAddOrImport" :loading="addingEmail || importing">
              确定
            </el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 邮件列表对话框 -->
      <el-dialog
        v-model="mailListDialogVisible"
        title="邮件列表"
        width="90%"
        top="5vh"
        class="mail-list-dialog"
        destroy-on-close
      >
        <div v-if="currentEmail" class="mail-dialog-header flex-between mb-4">
          <h3 class="email-title">
            <span class="text-primary">{{ currentEmail.email }}</span> 的邮件
          </h3>
          <el-button
            type="primary"
            size="small"
            @click="handleCheck(currentEmail)"
            :disabled="isEmailProcessing(currentEmail)"
            :icon="Refresh"
            class="refresh-btn hover-scale"
          >
            刷新邮件
          </el-button>
        </div>

        <el-table
          v-loading="loadingMails"
          :data="mailRecords"
          style="width: 100%"
          stripe
          border
          max-height="60vh"
          class="mail-list-table"
        >
          <el-table-column prop="subject" label="主题" min-width="250" show-overflow-tooltip>
            <template #default="scope">
              <div class="subject-cell">
                <span>{{ scope.row.subject }}</span>
                <el-tag v-if="scope.row.has_attachments" size="small" type="success" class="attachment-tag">
                  <el-icon><Document /></el-icon> 附件
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="sender" label="发件人" min-width="200" show-overflow-tooltip />
          <el-table-column prop="received_time" label="接收时间" width="180">
            <template #default="scope">
              <span class="time-field">{{ formatDate(scope.row.received_time) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="scope">
              <el-button
                type="primary"
                size="small"
                @click="viewMailContent(scope.row)"
                :icon="Document"
                class="view-btn"
              >
                查看
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-dialog>

      <!-- 邮件内容查看对话框 -->
      <el-dialog
        v-model="mailContentDialogVisible"
        :title="selectedMail ? selectedMail.subject : '邮件详情'"
        width="80%"
        top="5vh"
        class="mail-content-dialog"
      >
        <div v-if="selectedMail" class="mail-detail">
          <!-- 使用EmailContentViewer组件 -->
          <EmailContentViewer
            :mail="selectedMail"
            :attachments="selectedMail.attachments || []"
            :loading-attachments="false"
          />
        </div>
      </el-dialog>

      <!-- 编辑邮箱对话框 -->
      <el-dialog
        v-model="editDialogVisible"
        title="编辑邮箱"
        width="500px"
        @close="resetEditForm"
      >
        <el-form
          ref="editFormRef"
          :model="editForm"
          :rules="editRules"
          label-width="100px"
        >
          <el-form-item label="邮箱地址" prop="email">
            <el-input v-model="editForm.email" />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input
              v-model="editForm.password"
              type="password"
              show-password
              @input="checkPasswordStrength"
            >
              <template #append>
                <el-tooltip
                  content="密码应包含大小写字母、数字和特殊字符,长度至少8位"
                  placement="top"
                >
                  <el-icon><InfoFilled /></el-icon>
                </el-tooltip>
              </template>
            </el-input>
            <div class="password-strength" v-if="editForm.password">
              <span>密码强度:</span>
              <el-progress
                :percentage="passwordStrength"
                :color="passwordStrengthColor"
                :format="passwordStrengthText"
              />
            </div>
          </el-form-item>
          <!-- 显示邮箱类型但不能修改 -->
          <el-form-item label="邮箱类型">
            <el-tag :type="getMailTypeColor(editForm.mail_type)">
              {{ getMailTypeName(editForm.mail_type) }}
            </el-tag>
            <div class="form-tips">邮箱类型创建后不可修改</div>
          </el-form-item>
          <template v-if="editForm.mail_type === 'imap'">
            <div class="imap-tips">
              <h4>常用IMAP服务器配置:</h4>
              <p>Gmail: <code>imap.gmail.com</code> 端口: <code>993</code> SSL: 开启</p>
              <p>Outlook: <code>outlook.office365.com</code> 端口: <code>993</code> SSL: 开启</p>
              <p>QQ邮箱: <code>imap.qq.com</code> 端口: <code>993</code> SSL: 开启</p>
              <p>163邮箱: <code>imap.163.com</code> 端口: <code>993</code> SSL: 开启</p>
            </div>
            <el-form-item
              label="服务器"
              prop="server"
            >
              <el-input v-model="editForm.server">
                <template #append>
                  <el-tooltip content="IMAP服务器地址,如: imap.gmail.com" placement="top">
                    <el-icon><InfoFilled /></el-icon>
                  </el-tooltip>
                </template>
              </el-input>
            </el-form-item>
            <el-form-item
              label="端口"
              prop="port"
            >
              <el-input-number
                v-model="editForm.port"
                :min="1"
                :max="65535"
                controls-position="right"
              />
              <div class="form-tips">常用端口: SSL-993, 非SSL-143</div>
            </el-form-item>
            <el-form-item label="使用SSL" prop="use_ssl">
              <el-switch v-model="editForm.use_ssl" />
            </el-form-item>
          </template>
          <template v-if="editForm.mail_type === 'outlook'">
            <el-form-item label="Client ID" prop="client_id">
              <el-input v-model="editForm.client_id" />
            </el-form-item>
            <el-form-item label="Refresh Token" prop="refresh_token">
              <el-input v-model="editForm.refresh_token" />
            </el-form-item>
          </template>
        </el-form>
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="editDialogVisible = false">取消</el-button>
            <el-button type="primary" @click="submitEditForm">确定</el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 重新授权对话框 -->
      <el-dialog
        v-model="reauthorizeDialogVisible"
        title="重新授权"
        width="560px"
        class="reauthorize-dialog"
        @close="resetReauthorizeDialog"
      >
        <div v-loading="reauthorizeLoading" class="reauthorize-body">
          <!-- 邮箱账号密码信息 -->
          <div v-if="reauthorizeEmail" class="reauthorize-account-section">
            <div class="reauthorize-account-title">登录信息</div>
            <div class="reauthorize-account-row">
              <span class="reauthorize-account-label">邮箱账号：</span>
              <span class="reauthorize-account-value">{{ reauthorizeEmail.email }}</span>
              <el-button
                size="small"
                :icon="CopyDocument"
                @click="copyText(reauthorizeEmail.email, '邮箱账号')"
                circle
              />
            </div>
            <div class="reauthorize-account-row">
              <span class="reauthorize-account-label">邮箱密码：</span>
              <span class="reauthorize-account-value password-value">{{ reauthorizeEmail.password || '******' }}</span>
              <el-button
                size="small"
                :icon="CopyDocument"
                @click="copyText(reauthorizeEmail.password, '邮箱密码')"
                :disabled="!reauthorizeEmail.password || reauthorizeEmail.password === '******'"
                circle
              />
            </div>
          </div>

          <el-divider />

          <div class="reauthorize-section">
            <div class="reauthorize-label">1. 请在浏览器中访问以下链接</div>
            <el-link
              v-if="reauthorizeInfo.verificationUri"
              :href="reauthorizeInfo.verificationUri"
              target="_blank"
              type="primary"
              class="reauthorize-link"
            >
              {{ reauthorizeInfo.verificationUri }}
            </el-link>
            <div v-else class="reauthorize-placeholder">等待授权链接</div>
          </div>

          <div class="reauthorize-section">
            <div class="reauthorize-label">2. 登录后输入验证码</div>
            <div class="reauthorize-code-row">
              <div class="reauthorize-code">
                {{ reauthorizeInfo.userCode || '—' }}
              </div>
              <el-button
                size="small"
                type="primary"
                @click="copyUserCode"
                :disabled="!reauthorizeInfo.userCode"
              >
                {{ copied ? '已复制' : '复制' }}
              </el-button>
            </div>
          </div>

          <div class="reauthorize-meta">
            <div class="reauthorize-countdown">剩余时间：{{ countdownText }}</div>
            <div class="reauthorize-status">
              当前状态：
              <el-tag :type="reauthorizeStatusType" effect="plain">
                {{ reauthorizeStatusText }}
              </el-tag>
              <span v-if="currentReauthorizeMessage" class="reauthorize-message">
                {{ currentReauthorizeMessage }}
              </span>
            </div>
          </div>
        </div>

        <template #footer>
          <span class="dialog-footer">
            <el-button @click="reauthorizeDialogVisible = false">关闭</el-button>
          </span>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive, watch, onBeforeUnmount } from 'vue'
import { useEmailsStore } from '@/store/emails'
import { ElMessage, ElMessageBox, ElLoading } from 'element-plus'
import {
  Delete,
  Refresh,
  Plus,
  Download,
  Document,
  Message,
  View,
  Hide,
  InfoFilled,
  ArrowDown,
  CopyDocument
} from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import DOMPurify from 'dompurify'
import EmailContentViewer from '@/components/EmailContentViewer.vue'
import EmailAttachments from '@/components/EmailAttachments.vue'
import EmailQuoteFormatter from '@/components/EmailQuoteFormatter.vue'

const emailsStore = useEmailsStore()

// 状态
const loadingMails = ref(false)
const addEmailDialogVisible = ref(false)
const addEmailActiveTab = ref('single')
const mailContentDialogVisible = ref(false)
const mailListDialogVisible = ref(false)
const addingEmail = ref(false)
const importing = ref(false)
const reauthorizeDialogVisible = ref(false)
const reauthorizeLoading = ref(false)
const reauthorizeEmailId = ref(null)
const reauthorizeInfo = ref({
  verificationUri: '',
  userCode: '',
  expiresIn: 0
})
const reauthorizeEmail = ref(null) // 当前重新授权的邮箱信息
const reauthorizeCountdown = ref(null)
const reauthorizeExpiresAt = ref(0)
const copied = ref(false)
let reauthorizeTimer = null
let copyTimer = null

// 添加邮箱表单引用
const addEmailFormRef = ref(null)
const batchImportFormRef = ref(null)

// 邮箱类型配置
const mailTypes = {
  outlook: {
    name: 'Outlook/Hotmail',
    color: 'primary'
  },
  imap: {
    name: 'IMAP邮箱',
    color: 'info'
  },
  gmail: {
    name: 'Gmail',
    color: 'danger'
  },
  qq: {
    name: 'QQ邮箱',
    color: 'success'
  }
}

// 获取邮箱类型名称
const getMailTypeName = (type) => {
  return mailTypes[type]?.name || type
}

// 获取邮箱类型颜色
const getMailTypeColor = (type) => {
  return mailTypes[type]?.color || 'default'
}

// 添加邮箱表单
const addEmailForm = ref({
  mail_type: 'outlook',
  email: '',
  password: '',
  client_id: '',
  refresh_token: '',
  server: '',
  port: 993,
  use_ssl: true
})

// 批量导入数据
const batchImport = reactive({
  data: '',
  mailType: 'outlook'
})

// 批量导入验证规则
const batchImportRules = {
  data: [
    { required: true, message: '导入数据不能为空', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (!value) {
          callback()
          return
        }

        const lines = value.trim().split('\n')
        let hasError = false

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          if (!line) continue

          // 根据不同邮箱类型进行不同的验证
          if (batchImport.mailType === 'outlook') {
            const parts = line.split('----')
            if (parts.length !== 4) {
              hasError = true
              callback(new Error(`第 ${i + 1} 行格式错误，请使用"----"分隔邮箱、密码、客户端ID和RefreshToken`))
              break
            }

            if (!parts[0] || !parts[1] || !parts[2] || !parts[3]) {
              hasError = true
              callback(new Error(`第 ${i + 1} 行有空白字段，所有字段都必须填写`))
              break
            }

            // 简单的邮箱格式检查
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[0])) {
              hasError = true
              callback(new Error(`第 ${i + 1} 行邮箱格式不正确`))
              break
            }
          }
        }

        if (!hasError) {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

// 添加邮箱表单验证规则
const addEmailRules = {
  mail_type: [{ required: true, message: '请选择邮箱类型', trigger: 'change' }],
  email: [{ required: true, message: '请输入邮箱地址', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  client_id: [{ required: true, message: '请输入Client ID', trigger: 'blur', validator: (rule, value, callback) => {
    if (addEmailForm.value.mail_type === 'outlook' && !value) {
      callback(new Error('请输入Client ID'))
    } else {
      callback()
    }
  }}],
  refresh_token: [{ required: true, message: '请输入Refresh Token', trigger: 'blur', validator: (rule, value, callback) => {
    if (addEmailForm.value.mail_type === 'outlook' && !value) {
      callback(new Error('请输入Refresh Token'))
    } else {
      callback()
    }
  }}],
  server: [{ required: true, message: '请输入服务器地址', trigger: 'blur', validator: (rule, value, callback) => {
    if (addEmailForm.value.mail_type === 'imap' && !value) {
      callback(new Error('请输入服务器地址'))
    } else {
      callback()
    }
  }}],
  port: [{ required: true, message: '请输入端口号', trigger: 'blur' }]
}

const selectedMail = ref(null)

// 计算属性
const emails = computed(() => emailsStore.emails)
const loading = computed(() => emailsStore.loading)
const currentEmail = computed(() => emailsStore.getEmailById(emailsStore.currentEmailId))
const mailRecords = computed(() => emailsStore.currentMailRecords)
const hasSelectedEmails = computed(() => emailsStore.hasSelectedEmails)
const currentReauthorizeStatus = computed(() => {
  const status = emailsStore.reauthorizeStatus
  if (!status || status.emailId !== reauthorizeEmailId.value) {
    return { status: 'pending', message: '' }
  }
  return status
})
const reauthorizeStatusText = computed(() => {
  const status = currentReauthorizeStatus.value.status
  if (status === 'success') return '授权成功'
  if (status === 'error') return '授权失败'
  return '等待授权'
})
const reauthorizeStatusType = computed(() => {
  const status = currentReauthorizeStatus.value.status
  if (status === 'success') return 'success'
  if (status === 'error') return 'danger'
  return 'warning'
})
const currentReauthorizeMessage = computed(() => currentReauthorizeStatus.value.message || '')
const countdownText = computed(() => formatCountdown(reauthorizeCountdown.value))

// 方法
const refreshEmails = async () => {
  try {
    await emailsStore.fetchEmails()
    ElMessage.success('刷新成功')
  } catch (error) {
    console.error('获取邮箱列表失败:', error)
    ElMessage.error('获取邮箱列表失败，请检查网络连接')
  }
}

const handleSelectionChange = (selection) => {
  if (Array.isArray(selection)) {
    emailsStore.selectedEmails = selection.map(item => item.id)
  } else {
    emailsStore.selectedEmails = []
  }
}

const handleDelete = (row) => {
  ElMessageBox.confirm(
    `确定要删除邮箱 ${row.email} 吗？`,
    '提示',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(async () => {
    try {
      await emailsStore.deleteEmail(row.id)
      ElMessage.success('删除成功')
    } catch (error) {
      console.error('删除邮箱失败:', error)
      ElMessage.error('删除邮箱失败: ' + (error.message || '未知错误'))
    }
  }).catch(() => {
    // 取消删除，不做任何操作
  })
}

const handleBatchDelete = () => {
  if (!hasSelectedEmails.value) {
    ElMessage.warning('请先选择要删除的邮箱')
    return
  }

  const count = emailsStore.selectedEmailsCount
  // 确保是数组并且创建副本
  const emailIds = Array.isArray(emailsStore.selectedEmails) ?
    [...emailsStore.selectedEmails] : []

  if (emailIds.length === 0) {
    ElMessage.warning('没有选中有效的邮箱')
    return
  }

  ElMessageBox.confirm(
    `确定要删除选中的 ${count} 个邮箱吗？`,
    '批量删除确认',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(async () => {
    try {
      await emailsStore.deleteEmails(emailIds)
      ElMessage.success(`已成功删除 ${count} 个邮箱`)
    } catch (error) {
      console.error('批量删除邮箱失败:', error)
      ElMessage.error('批量删除邮箱失败: ' + (error.message || '未知错误'))
    }
  }).catch(() => {
    // 取消删除，不做任何操作
  })
}

const handleCheck = async (row) => {
  try {
    const result = await emailsStore.checkEmail(row.id)

    // 检查结果，确定是否显示正在处理中的消息
    if (result && result.status === 'processing') {
      ElMessage.warning(result.message || '邮箱正在处理中，请稍候...')
    } else {
      ElMessage.info(`正在检查邮箱 ${row.email} 的邮件，请稍候...`)
    }
  } catch (error) {
    console.error('检查邮箱失败:', error)
    ElMessage.error('检查邮箱失败: ' + (error.message || '未知错误'))
  }
}

const handleBatchCheck = async () => {
  if (!hasSelectedEmails.value) {
    ElMessage.warning('请先选择要检查的邮箱')
    return
  }

  const count = emailsStore.selectedEmailsCount
  // 确保是数组并且创建副本
  const emailIds = Array.isArray(emailsStore.selectedEmails) ?
    [...emailsStore.selectedEmails] : []

  if (emailIds.length === 0) {
    ElMessage.warning('没有选中有效的邮箱')
    return
  }

  try {
    await emailsStore.checkEmails(emailIds)
    ElMessage.info(`正在检查 ${count} 个邮箱的邮件，请稍候...`)
  } catch (error) {
    console.error('批量检查邮箱失败:', error)
    ElMessage.error('批量检查邮箱失败: ' + (error.message || '未知错误'))
  }
}

const handleViewMails = async (row) => {
  loadingMails.value = true
  try {
    emailsStore.currentEmailId = row.id
    await emailsStore.fetchMailRecords(row.id)
    mailListDialogVisible.value = true
  } catch (error) {
    console.error('获取邮件记录失败:', error)
    ElMessage.error('获取邮件记录失败: ' + (error.message || '未知错误'))
  } finally {
    loadingMails.value = false
  }
}

const clearReauthorizeTimer = () => {
  if (reauthorizeTimer) {
    clearInterval(reauthorizeTimer)
    reauthorizeTimer = null
  }
}

const updateReauthorizeCountdown = () => {
  if (!reauthorizeExpiresAt.value) {
    reauthorizeCountdown.value = null
    return
  }
  const remainingMs = reauthorizeExpiresAt.value - Date.now()
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  reauthorizeCountdown.value = remainingSeconds
  if (remainingSeconds === 0) {
    clearReauthorizeTimer()
  }
}

const startReauthorizeCountdown = (expiresIn) => {
  clearReauthorizeTimer()
  const seconds = Number(expiresIn) || 0
  if (seconds > 0) {
    reauthorizeExpiresAt.value = Date.now() + seconds * 1000
    updateReauthorizeCountdown()
    reauthorizeTimer = setInterval(updateReauthorizeCountdown, 1000)
  } else {
    reauthorizeExpiresAt.value = 0
    reauthorizeCountdown.value = null
  }
}

const formatCountdown = (seconds) => {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds <= 0) return '已过期'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const resetReauthorizeDialog = () => {
  reauthorizeLoading.value = false
  reauthorizeEmailId.value = null
  reauthorizeEmail.value = null
  reauthorizeInfo.value = {
    verificationUri: '',
    userCode: '',
    expiresIn: 0
  }
  reauthorizeExpiresAt.value = 0
  reauthorizeCountdown.value = null
  copied.value = false
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
  clearReauthorizeTimer()
}

// 通用复制方法
const copyText = async (text, label = '内容') => {
  if (!text) return

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    ElMessage.success(`${label}已复制`)
  } catch (error) {
    console.error(`复制${label}失败:`, error)
    ElMessage.error('复制失败，请手动复制')
  }
}

const copyUserCode = async () => {
  const code = reauthorizeInfo.value.userCode
  if (!code) return

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(code)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = code
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }

    copied.value = true
    if (copyTimer) {
      clearTimeout(copyTimer)
    }
    copyTimer = setTimeout(() => {
      copied.value = false
      copyTimer = null
    }, 1500)
    ElMessage.success('验证码已复制')
  } catch (error) {
    console.error('复制验证码失败:', error)
    ElMessage.error('复制失败，请手动复制')
  }
}

// 处理下拉菜单命令
const handleActionCommand = (command, row) => {
  switch (command) {
    case 'view':
      handleViewMails(row)
      break
    case 'edit':
      handleEdit(row)
      break
    case 'reauthorize':
      handleReauthorize(row)
      break
    case 'delete':
      handleDelete(row)
      break
  }
}

const handleReauthorize = async (row) => {
  reauthorizeDialogVisible.value = true
  reauthorizeLoading.value = true
  reauthorizeEmailId.value = row.id
  reauthorizeEmail.value = { ...row } // 保存当前邮箱信息
  reauthorizeInfo.value = {
    verificationUri: '',
    userCode: '',
    expiresIn: 0
  }
  reauthorizeExpiresAt.value = 0
  reauthorizeCountdown.value = null
  copied.value = false
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
  clearReauthorizeTimer()

  // 如果密码是隐藏的，先获取密码
  if (!row.password || row.password === '******') {
    try {
      const response = await emailsStore.getEmailPassword(row.id)
      if (response && response.password) {
        reauthorizeEmail.value.password = response.password
      }
    } catch (error) {
      console.error('获取密码失败:', error)
    }
  }

  try {
    const data = await emailsStore.reauthorize(row.id)
    const verificationUri = data?.verification_uri || data?.verificationUri || ''
    const userCode = data?.user_code || data?.userCode || ''
    const expiresIn = Number(data?.expires_in ?? data?.expiresIn ?? 0)
    reauthorizeInfo.value = {
      verificationUri,
      userCode,
      expiresIn
    }
    startReauthorizeCountdown(expiresIn)
  } catch (error) {
    console.error('重新授权失败:', error)
  } finally {
    reauthorizeLoading.value = false
  }
}

const viewMailContent = (mail) => {
  // 增加防护检查，确保mail对象及其必要字段存在
  if (!mail) {
    ElMessage.warning('邮件数据不存在或格式错误');
    return;
  }

  // 创建一个格式化后的副本，防止直接修改原始数据
  const formattedMail = {
    ...mail,
    subject: mail.subject || '(无主题)',
    sender: mail.sender || '(未知发件人)',
    received_time: mail.received_time || new Date().toISOString(),
    content: mail.content || '(无内容)'
  };

  selectedMail.value = formattedMail;
  mailContentDialogVisible.value = true;
}

const showAddEmailDialog = () => {
  resetAddEmailForm()
  addEmailDialogVisible.value = true
  addEmailActiveTab.value = 'single'
}

const handleAddOrImport = async () => {
  if (addEmailActiveTab.value === 'single') {
    await handleAddEmail()
  } else {
    await handleImport()
  }
}

const handleAddEmail = async () => {
  if (!addEmailFormRef.value) return

  try {
    // 表单验证
    await addEmailFormRef.value.validate()

    addingEmail.value = true
    const loading = ElLoading.service({
      lock: true,
      text: '正在添加邮箱...',
      background: 'rgba(0, 0, 0, 0.7)'
    })

    const formData = {
      email: addEmailForm.value.email,
      password: addEmailForm.value.password,
      mail_type: addEmailForm.value.mail_type
    }

    if (addEmailForm.value.mail_type === 'outlook') {
      formData.client_id = addEmailForm.value.client_id
      formData.refresh_token = addEmailForm.value.refresh_token
    } else if (addEmailForm.value.mail_type === 'imap') {
      formData.server = addEmailForm.value.server
      formData.port = addEmailForm.value.port
      formData.use_ssl = addEmailForm.value.use_ssl
    }

    await emailsStore.addEmail(formData)
    addEmailDialogVisible.value = false
    ElMessage.success('添加邮箱成功')

    // 刷新邮箱列表
    await refreshEmails()
  } catch (error) {
    console.error('添加邮箱失败:', error)
    ElMessage.error('添加邮箱失败: ' + (error.message || '未知错误'))
  } finally {
    addingEmail.value = false
    ElLoading.service().close()
  }
}

const handleImport = async () => {
  if (!batchImportFormRef.value) return

  try {
    await batchImportFormRef.value.validate()

    importing.value = true

    const importData = {
      data: batchImport.data.trim(),
      mail_type: batchImport.mailType
    }

    await emailsStore.importEmails(importData)
    ElMessage.info('正在处理导入请求，请稍候...')

    // 延迟刷新列表
    setTimeout(async () => {
      await refreshEmails()
      ElMessage.success('批量导入完成')
      addEmailDialogVisible.value = false
    }, 2000)
  } catch (error) {
    console.error('导入邮箱失败:', error)
    ElMessage.error('导入邮箱失败: ' + (error.message || '未知错误'))
  } finally {
    importing.value = false
  }
}

const resetAddEmailForm = () => {
  addEmailForm.value = {
    mail_type: 'outlook',
    email: '',
    password: '',
    client_id: '',
    refresh_token: '',
    server: '',
    port: 993,
    use_ssl: true
  }
}

// 格式化日期
const formatDate = (dateString) => {
  if (!dateString) return '无';
  return dayjs(dateString).format('YYYY-MM-DD HH:mm:ss');
};

// 判断邮箱是否正在处理中
const isEmailProcessing = (email) => {
  const status = emailsStore.getProcessingStatus(email.id)
  return status && status.progress >= 0 && status.progress < 100
}

// 获取邮箱操作文本
const getEmailActionText = (email) => {
  return isEmailProcessing(email) ? '检查中...' : '检查邮件'
}

const togglePasswordVisibility = async (row) => {
  // 如果已经显示密码，则隐藏
  if (row.showPassword) {
    row.showPassword = false;
    return;
  }

  // 否则，从后端获取密码
  if (!row.password || row.password === '******') {
    row.passwordLoading = true;
    try {
      const response = await emailsStore.getEmailPassword(row.id);
      if (response && response.password) {
        row.password = response.password;
      }
    } catch (error) {
      console.error('获取密码失败:', error);
      ElMessage.error('获取密码失败: ' + (error.message || '未知错误'));
    } finally {
      row.passwordLoading = false;
    }
  }

  // 显示密码
  row.showPassword = true;
}

// 检查邮件内容是否为HTML格式
const isHtmlContent = (mail) => {
  if (!mail || !mail.content) return false;

  // 兼容新旧格式
  if (typeof mail.content === 'object') {
    return mail.content.has_html === true || mail.content.content_type === 'text/html';
  }

  // 旧格式，检查内容是否包含HTML标签
  const content = String(mail.content);
  return content.includes('<html') || content.includes('<body') ||
         content.includes('<div') || content.includes('<p>') ||
         content.includes('<table') || content.includes('<img');
}

// 获取邮件内容
const getMailContent = (mail) => {
  if (!mail) return '';

  // 兼容新旧格式
  if (typeof mail.content === 'object' && mail.content !== null) {
    return mail.content.content || '';
  }

  return mail.content || '';
}

// 截断内容
const truncateContent = (content) => {
  if (!content) return content;

  const maxLength = 1000; // 设置最大长度
  if (content.length > maxLength) {
    return content.slice(0, maxLength) + '...';
  }
  return content;
}

// 净化HTML内容，防止XSS攻击
const sanitizeHtml = (html) => {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'i', 'img', 'li', 'ol', 'p', 'span', 'strong', 'table', 'tbody',
      'td', 'th', 'thead', 'tr', 'u', 'ul', 'font', 'blockquote', 'hr',
      'pre', 'code', 'col', 'colgroup', 'section', 'header', 'footer',
      'nav', 'article', 'aside', 'figure', 'figcaption', 'address', 'main',
      'caption', 'center', 'cite', 'dd', 'dl', 'dt', 'mark', 's', 'small',
      'strike', 'sub', 'sup'
    ],
    ALLOWED_ATTR: [
      'href', 'target', 'src', 'alt', 'style', 'class', 'id', 'width', 'height',
      'align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
      'color', 'colspan', 'dir', 'face', 'frame', 'frameborder', 'headers',
      'hspace', 'lang', 'marginheight', 'marginwidth', 'nowrap', 'rel',
      'rev', 'rowspan', 'scrolling', 'shape', 'span', 'summary', 'title',
      'usemap', 'vspace', 'start', 'type', 'value', 'size', 'data-*'
    ]
  });
}

// 下载附件
const downloadAttachment = (attachmentId, filename) => {
  const token = localStorage.getItem('token')
  const downloadUrl = `/api/attachments/${attachmentId}/download`

  // 创建一个隐藏的a标签用于下载
  const link = document.createElement('a')
  link.href = downloadUrl
  link.setAttribute('download', filename)
  link.setAttribute('target', '_blank')

  // 添加认证头
  fetch(downloadUrl, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  })
  .then(response => response.blob())
  .then(blob => {
    const url = window.URL.createObjectURL(blob)
    link.href = url
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  })
  .catch(error => {
    console.error('下载附件失败:', error)
    ElMessage.error('下载附件失败')
  })
}

// 格式化文件大小
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 添加编辑按钮的处理函数
const handleEdit = (email) => {
  // 确保use_ssl是布尔值
  const emailData = { ...email }
  if (emailData.mail_type === 'imap') {
    emailData.use_ssl = Boolean(emailData.use_ssl)
  }
  editForm.value = emailData
  editDialogVisible.value = true
}

// 引用和定义编辑对话框相关变量
const editDialogVisible = ref(false)
const editFormRef = ref(null)
const editForm = ref({
  id: null,
  email: '',
  password: '',
  mail_type: 'outlook',
  server: '',
  port: 993,
  use_ssl: true,
  client_id: '',
  refresh_token: ''
})

// 密码强度相关
const passwordStrength = ref(0)
const passwordStrengthColor = computed(() => {
  if (passwordStrength.value < 40) return '#F56C6C'
  if (passwordStrength.value < 80) return '#E6A23C'
  return '#67C23A'
})

const passwordStrengthText = (percentage) => {
  if (percentage < 40) return '弱'
  if (percentage < 80) return '中'
  return '强'
}

const checkPasswordStrength = (password) => {
  if (!password) {
    passwordStrength.value = 0
    return
  }

  let strength = 0
  // 检查长度
  if (password.length >= 8) strength += 20
  // 检查是否包含数字
  if (/\d/.test(password)) strength += 20
  // 检查是否包含小写字母
  if (/[a-z]/.test(password)) strength += 20
  // 检查是否包含大写字母
  if (/[A-Z]/.test(password)) strength += 20
  // 检查是否包含特殊字符
  if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) strength += 20

  passwordStrength.value = strength
}

// 编辑表单的规则
const editRules = {
  email: [
    { required: true, message: '邮箱地址不能为空', trigger: 'blur' },
    { type: 'email', message: '邮箱地址格式不正确', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '密码不能为空', trigger: 'blur' },
    { min: 6, message: '密码长度不能小于6位', trigger: 'blur' }
  ],
  server: [
    { required: true, message: 'IMAP服务器地址不能为空', trigger: 'blur',
      // 仅当类型为imap时验证
      validator: (rule, value, callback) => {
        if (editForm.value.mail_type === 'imap' && !value) {
          callback(new Error('IMAP服务器地址不能为空'));
        } else {
          callback();
        }
      }
    }
  ],
  port: [
    {
      required: true,
      message: '端口号不能为空',
      trigger: 'blur',
      // 仅当类型为imap时验证
      validator: (rule, value, callback) => {
        if (editForm.value.mail_type === 'imap' && (!value || isNaN(value))) {
          callback(new Error('端口号必须是有效数字'));
        } else {
          callback();
        }
      }
    }
  ],
  client_id: [
    {
      required: true,
      message: 'Client ID不能为空',
      trigger: 'blur',
      // 仅当类型为outlook时验证
      validator: (rule, value, callback) => {
        if (editForm.value.mail_type === 'outlook' && !value) {
          callback(new Error('Client ID不能为空'));
        } else {
          callback();
        }
      }
    }
  ],
  refresh_token: [
    {
      required: true,
      message: 'Refresh Token不能为空',
      trigger: 'blur',
      // 仅当类型为outlook时验证
      validator: (rule, value, callback) => {
        if (editForm.value.mail_type === 'outlook' && !value) {
          callback(new Error('Refresh Token不能为空'));
        } else {
          callback();
        }
      }
    }
  ],
}

// 重置编辑表单
const resetEditForm = () => {
  editForm.value = {
    id: null,
    email: '',
    password: '******',  // 默认显示星号，实际修改时会获取真实密码
    mail_type: 'outlook',
    client_id: '',
    refresh_token: '',
    server: '',
    port: 993,
    use_ssl: true
  }
}

// 提交编辑表单
const submitEditForm = async () => {
  if (!editFormRef.value) return

  try {
    await editFormRef.value.validate()

    // 准备提交的数据
    const formData = { ...editForm.value }

    // 如果密码仍然是默认的星号，则不发送密码更新
    if (formData.password === '******') {
      delete formData.password
    }

    const loading = ElLoading.service({
      lock: true,
      text: '正在更新邮箱...',
      background: 'rgba(0, 0, 0, 0.7)'
    })

    await emailsStore.updateEmail(formData.id, formData)
    editDialogVisible.value = false

    // 刷新邮箱列表
    await refreshEmails()

    ElMessage.success('邮箱更新成功')
  } catch (error) {
    console.error('更新邮箱失败:', error)
    ElMessage.error('更新邮箱失败: ' + (error.message || '未知错误'))
  } finally {
    ElLoading.service().close()
  }
}

watch(
  () => emailsStore.reauthorizeStatus,
  (status) => {
    if (!status || status.emailId !== reauthorizeEmailId.value) return

    if (status.status === 'success') {
      ElMessage.success('授权成功')
      reauthorizeDialogVisible.value = false
    } else if (status.status === 'error') {
      ElMessage.error(status.message || '授权失败')
    }
  }
)

onBeforeUnmount(() => {
  resetReauthorizeDialog()
})

// 生命周期钩子
onMounted(() => {
  emailsStore.initWebSocketListeners()
  refreshEmails()
})
</script>

<style scoped>
.page-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background-color: var(--bg-color);
  overflow-x: hidden;
}

.emails-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.email-list-card {
  margin-bottom: 20px;
  transition: all var(--transition-normal);
}

.card-header {
  width: 100%;
}

.page-title {
  font-size: 1.5rem;
  color: var(--primary-color);
  margin: 0;
  position: relative;
  display: inline-block;
}

.page-title::after {
  content: '';
  position: absolute;
  bottom: -5px;
  left: 0;
  width: 40px;
  height: 3px;
  background-color: var(--primary-color);
  border-radius: 999px;
}

.email-table {
  border-radius: var(--border-radius);
  overflow: hidden;
}

.mail-type-tag {
  font-weight: 500;
}

.password-field {
  width: 100%;
}

.password-text {
  font-family: monospace;
}

.password-toggle-btn:hover {
  transform: scale(1.1);
}

.time-field {
  color: var(--secondary-text-color);
  font-size: 0.9rem;
}

.progress-container {
  width: 100%;
  padding: 0 5px;
}

.progress-message {
  font-size: 0.8rem;
  margin-top: 4px;
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mail-dialog-header {
  padding: 0 0 10px 0;
  border-bottom: 1px solid var(--border-color-light);
}

.email-title {
  font-size: 1.2rem;
  margin: 0;
}

.mail-list-table {
  border-radius: var(--border-radius);
  overflow: hidden;
}

.subject-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attachment-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.mail-detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.mail-info {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.info-item {
  width: 100%;
}

.label {
  font-weight: 500;
  margin-right: 10px;
}

.mail-content {
  max-height: 400px;
  overflow-y: auto;
}

.mail-attachments {
  margin: 10px 0;
  padding: 10px;
  background-color: #f0f9eb;
  border-radius: 4px;
  border-left: 3px solid #67c23a;
}

.attachments-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}

.attachment-item {
  margin-bottom: 5px;
}

.mail-content-text {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  max-width: 100%;
  font-family: monospace;
  font-size: 0.9rem;
  line-height: 1.5;
  padding: 10px;
  background-color: var(--bg-light);
  border-radius: var(--border-radius);
}

.html-content {
  max-width: 100%;
  overflow-x: auto;
  padding: 10px;
  background-color: var(--bg-light);
  border-radius: var(--border-radius);
  line-height: 1.5;
}

.html-content img {
  max-width: 100%;
  height: auto;
}

.html-content a {
  color: var(--primary-color);
  text-decoration: underline;
}

.html-content table {
  border-collapse: collapse;
  margin: 10px 0;
}

.html-content th,
.html-content td {
  border: 1px solid #ddd;
  padding: 8px;
}

.add-email-form {
  padding: 20px;
}

.w-full {
  width: 100%;
}

.import-help {
  margin-bottom: 20px;
  padding: 10px;
  background-color: var(--bg-light);
  border-radius: var(--border-radius);
  font-size: 0.9rem;
  line-height: 1.5;
}

.server-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85rem;
}

.server-field, .port-field, .config-info {
  color: var(--secondary-text-color);
}

.config-info {
  font-style: italic;
  font-size: 0.85rem;
}

.flex {
  display: flex;
  align-items: center;
}

.flex-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.gap-sm {
  gap: 8px;
}

.gap-md {
  gap: 16px;
}

.mb-4 {
  margin-bottom: 16px;
}

.text-center {
  text-align: center;
}

.text-primary {
  color: var(--primary-color);
}

.hover-scale {
  transition: transform 0.2s;
}

.hover-scale:hover:not(:disabled) {
  transform: scale(1.05);
}

.reauthorize-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 4px;
}

.reauthorize-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reauthorize-label {
  color: var(--secondary-text-color);
  font-weight: 500;
}

.reauthorize-link {
  word-break: break-all;
}

.reauthorize-placeholder {
  color: var(--secondary-text-color);
  font-size: 0.9rem;
}

.reauthorize-code-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.reauthorize-code {
  font-family: monospace;
  font-size: 1.8rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  padding: 10px 16px;
  background: var(--bg-light);
  border-radius: var(--border-radius);
}

.reauthorize-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reauthorize-countdown {
  color: var(--secondary-text-color);
}

.reauthorize-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.reauthorize-message {
  color: var(--secondary-text-color);
  font-size: 0.9rem;
}

.reauthorize-account-section {
  background: var(--bg-light);
  border-radius: var(--border-radius);
  padding: 12px 16px;
}

.reauthorize-account-title {
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--primary-color);
}

.reauthorize-account-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.reauthorize-account-row:last-child {
  margin-bottom: 0;
}

.reauthorize-account-label {
  color: var(--secondary-text-color);
  min-width: 80px;
}

.reauthorize-account-value {
  flex: 1;
  font-family: monospace;
  word-break: break-all;
}

.reauthorize-account-value.password-value {
  font-weight: 500;
}
</style>
