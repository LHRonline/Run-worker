; Run worker — NSIS 安装脚本扩展
; 负责：写入用户级环境变量（RUN_WORKER_HOME / PATH）、卸载时清理。
; 自定义安装目录、开始菜单快捷方式由 electron-builder 的 nsis 配置项负责（见 electron-builder.yml）。
; 注意：安装器与卸载器是分开编译的，宏内不要定义仅供单侧使用的自定义 Function，
; 否则另一侧会报 "function not referenced"（electron-builder 把 warning 当 error）。

!include "LogicLib.nsh"

; 广播 WM_SETTINGCHANGE，让资源管理器与新开终端立即读到新的环境变量。
; 注意：必须用 PostMessageW（异步，立即返回）而非 SendMessageW（同步等待所有顶层窗口处理）。
; 在静默安装 / 无桌面会话的 headless 环境下，SendMessageW(HWND_BROADCAST, ...) 会卡死，
; 表现为「一键升级 / 静默安装」长时间无响应。PostMessageW 仅投递不等待，彻底避免该死锁。
!macro RW_BROADCAST_ENV
  System::Call 'user32::PostMessageW(i 0xffff, i 0x001A, i 0, w "Environment") i .r0'
!macroend

!macro customInstall
  DetailPrint "正在配置 Run worker 环境变量..."

  ; 1) RUN_WORKER_HOME 指向安装目录
  WriteRegExpandStr HKCU "Environment" "RUN_WORKER_HOME" "$INSTDIR"

  ; 2) 安装目录追加到用户 PATH；若末尾已是该目录则跳过（重复安装不产生重复项）
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    DetailPrint "已创建用户 PATH：$INSTDIR"
  ${Else}
    StrLen $1 $0
    StrLen $2 "$INSTDIR"
    IntOp $3 $1 - $2
    StrCpy $4 ""
    ${If} $3 >= 0
      StrCpy $4 $0 $2 $3
    ${EndIf}
    ${If} $4 == "$INSTDIR"
      DetailPrint "PATH 末尾已是该目录，跳过追加"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
      DetailPrint "已将 $INSTDIR 追加到用户 PATH"
    ${EndIf}
  ${EndIf}

  ; 3) 广播变更
  !insertmacro RW_BROADCAST_ENV

  ; 4) 记录安装信息，运行时可通过注册表反查安装位置
  WriteRegStr HKCU "Software\RunWorker" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\RunWorker" "Version" "${VERSION}"
!macroend

!macro customUnInstall
  DetailPrint "正在清理 Run worker 环境变量..."

  ; 移除 RUN_WORKER_HOME
  DeleteRegValue HKCU "Environment" "RUN_WORKER_HOME"

  ; 从 PATH 移除安装目录：安装时追加在末尾，这里按长度从尾部精确裁剪，避免误删相似路径
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 != ""
    StrLen $1 $0
    StrLen $2 "$INSTDIR"
    IntOp $3 $1 - $2
    ${If} $3 >= 0
      StrCpy $4 $0 $2 $3
      ${If} $4 == "$INSTDIR"
        StrCpy $5 $0 $3
        IntOp $6 $3 - 1
        StrCpy $7 $5 1 $6
        ${If} $7 == ";"
          StrCpy $5 $5 $6
        ${EndIf}
        WriteRegExpandStr HKCU "Environment" "Path" "$5"
        DetailPrint "已从用户 PATH 移除安装目录"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  !insertmacro RW_BROADCAST_ENV
  DeleteRegKey HKCU "Software\RunWorker"
!macroend
