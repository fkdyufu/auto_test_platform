# AI Test Runner

## 设备控制工具

测试单执行时，平台只会向 Agent 注册所选物理环境中实际可用的控制工具。模型调用工具时使用设备 ID 和控制接口 ID，地址及凭据由服务端从设备资源中读取。

| 控制接口类型 | Agent 工具 | 地址格式 |
| --- | --- | --- |
| SSH | `device_ssh_exec` | `192.168.1.1:22` 或 `ssh://192.168.1.1:22` |
| Telnet | `device_telnet_exec` | `192.168.1.1:23` 或 `telnet://192.168.1.1:23` |
| 串口 | `device_serial_exec` | `/dev/ttyUSB0?baudRate=115200&dataBits=8&stopBits=1&parity=none` |
| API | `device_http_request` | `http://192.168.1.1/api/` |

SSH 需要配置账号，密码可以留空。Telnet 会使用已配置的账号密码完成登录。API 同时配置账号和密码时使用 Basic Auth；只配置密码时将密码作为 Bearer Token。串口当前支持服务端本机可访问的串口路径，默认参数为 `115200/8N1`。

设备工具返回真实输出后会记录一次执行证据，因此纯 SSH、Telnet、串口或 API 用例也可以通过 `finish_test` 提交通过结论。连接失败或操作被取消时不会记录执行证据。

## 禅道用例导入

在“设置 / 禅道设置”中配置禅道地址、账号和密码。平台固定使用 REST API v1 路径 `/api.php/v1`，运行时自动获取 Token，并在认证失效后重新登录一次。

产品需要填写有效的禅道产品 ID 才能导入用例。用例库支持从禅道产品用例库或指定禅道测试单选择用例；平台使用禅道用例 ID 判断重复，默认跳过已经导入的用例。勾选“覆盖已导入用例”后会更新名称、步骤和预期结果，但始终保留平台中设置的测试场景。

## 本地运行

需要 Node.js 22.19.0 或更高版本。

```bash
npm install
npm run dev
```
