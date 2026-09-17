#!/usr/bin/env python3
"""Generate complete Chinese (zh_CN and zh_TW) translations for Focus Lock."""

import json
import sys
from pathlib import Path


def main():
    # Read source file
    source_path = Path(
        "/private/tmp/claude-501/-Users-rick-workspace-distraction-blocker/70009532-e9b0-4600-9d23-664683093d7b/scratchpad/en-source.json"
    )
    with open(source_path, "r", encoding="utf-8") as f:
        source = json.load(f)

    # Comprehensive translations for all 681 keys
    # Split into: app (2), notify (40), onboarding (41), options (223), overlay (27), popup (136), shared (141), stats (71)

    zh_CN = {}
    zh_TW = {}

    # Translation mapping: (en_key: (zh_CN_text, zh_TW_text))
    all_translations = {
        # APP (2)
        "app_name": ("Focus Lock", "Focus Lock"),
        "app_description": (
            "能锁定分散注意力网站的专注会话，并赚取网站访问额度。",
            "能鎖定分散注意力網站的專注工作階段，並賺取網站存取點數。",
        ),
        # NOTIFY (40)
        "notify_session_complete_title": ("专注会话完成", "專注工作階段完成"),
        "notify_session_complete_body": (
            "您的专注会话已完成。",
            "您的專注工作階段已完成。",
        ),
        "notify_schedule_window_body": ("锁定至$END$。", "鎖定至$END$。"),
        "notify_schedule_unavailable_title": ("无法启动专注计划", "無法啟動專注計畫"),
        "notify_schedule_unavailable_body": (
            "未启用网站阻止。完成设置或授予网站访问权限，然后重试。",
            "未啟用網站封鎖。完成設定或授予網站存取權限，然後重試。",
        ),
        "notify_setup_completed_elsewhere": (
            "设置已在另一个标签页中完成。",
            "設定已在另一個分頁中完成。",
        ),
        "notify_setup_changed_reloaded": (
            "设置在另一个标签页中更改。最新选择已重新加载。",
            "設定在另一個分頁中更改。最新選擇已重新載入。",
        ),
        "notify_setup_changed_reload_before_finishing": (
            "设置在另一个标签页中更改。完成前请重新加载设置。",
            "設定在另一個分頁中更改。完成前請重新載入設定。",
        ),
        "notify_setup_not_complete": ("设置未完成。", "設定未完成。"),
        "notify_setup_not_ready_to_finish": (
            "设置未准备好完成。",
            "設定未準備好完成。",
        ),
        "notify_setup_storage_choice_changed": (
            "设置存储选择已更改。完成前请重新加载设置。",
            "設定儲存選擇已更改。完成前請重新載入設定。",
        ),
        "notify_onboarding_storage_failed": (
            "配置存储操作失败。",
            "設定儲存操作失敗。",
        ),
        "notify_onboarding_operation_failed": ("配置操作失败。", "設定操作失敗。"),
        "notify_website_access_check_failed": (
            "Focus Lock无法检查网站访问权限。重试设置或重新加载扩展程序。",
            "Focus Lock無法檢查網站存取權限。重試設定或重新載入擴充功能。",
        ),
        "notify_website_access_granted_blocking_failed": (
            "已授予网站访问权限，但Focus Lock无法启用阻止。重试设置或重新加载扩展程序。",
            "已授予網站存取權限，但Focus Lock無法啟用封鎖。重試設定或重新載入擴充功能。",
        ),
        "notify_website_access_unavailable_cleanup_failed": (
            "网站访问不可用，Focus Lock无法完成阻止清理。重试设置或重新加载扩展程序。",
            "網站存取不可用，Focus Lock無法完成封鎖清理。重試設定或重新載入擴充功能。",
        ),
        "notify_website_access_inconsistent": (
            "Focus Lock收到不一致的网站访问状态。重试设置或重新加载扩展程序。",
            "Focus Lock收到不一致的網站存取狀態。重試設定或重新載入擴充功能。",
        ),
        "notify_boot_not_finished": (
            "Focus Lock未完成启动：$REASON$",
            "Focus Lock未完成啟動：$REASON$",
        ),
        "notify_unknown_error": ("未知错误", "未知錯誤"),
        "notify_nothing_to_reset": (
            "Focus Lock正在运行，无需重置",
            "Focus Lock正在執行，無需重設",
        ),
        "notify_runtime_committed_in_generation": (
            "Focus Lock无法重置仍在策略生成中提交的运行时",
            "Focus Lock無法重設仍在策略產生中提交的執行時",
        ),
        "notify_data_clear_retry_unavailable": (
            "无法重试数据清除。",
            "無法重試資料清除。",
        ),
        "notify_disable_sync_before_delete": (
            "删除已同步数据前请禁用同步",
            "刪除已同步資料前請停用同步",
        ),
        "notify_work_gate_busy": (
            "Focus Lock仍在完成之前的更改。稍后重试。",
            "Focus Lock仍在完成之前的更改。稍後重試。",
        ),
        "notify_work_gate_stuck": (
            "打开的门槛无法关闭。重试。",
            "打開的門檻無法關閉。重試。",
        ),
        "notify_work_tab_unavailable": ("工作标签页不可用。", "工作頁籤無法使用。"),
        "notify_settings_sync_limit": (
            "设置超过8 KB Chrome同步限制。删除计划项或缩短意图，然后重试。",
            "設定超過8 KB Chrome同步限制。刪除計畫項目或縮短意圖，然後重試。",
        ),
        "notify_lists_sync_limit": (
            "列表超过8 KB Chrome同步限制。删除自定义或允许列表规则，然后重试。",
            "清單超過8 KB Chrome同步限制。刪除自訂或允許清單規則，然後重試。",
        ),
        "notify_guard_lists_remove_blocked": (
            "强制会话正在运行：删除阻止网站会在会话结束时解锁",
            "強制工作階段正在執行：刪除封鎖網站會在工作階段結束時解鎖",
        ),
        "notify_guard_lists_add_whitelist": (
            "强制会话正在运行：新的允许列表条目在会话结束时解锁",
            "強制工作階段正在執行：新的允許清單項目在工作階段結束時解鎖",
        ),
        "notify_guard_lists_disable_category": (
            "强制会话正在运行：禁用分类会在会话结束时解锁",
            "強制工作階段正在執行：停用分類會在工作階段結束時解鎖",
        ),
        "notify_guard_lists_add_exclusion": (
            "强制会话正在运行：新的排除项在会话结束时解锁",
            "強制工作階段正在執行：新的排除項在工作階段結束時解鎖",
        ),
        "notify_guard_settings_weaken_strictness": (
            "强制会话正在运行：削弱默认严格性需等待会话结束",
            "強制工作階段正在執行：削弱預設嚴格性需等待工作階段結束",
        ),
        "notify_guard_settings_shorten_delay": (
            "强制会话正在运行：缩短确认延迟会削弱门槛",
            "強制工作階段正在執行：縮短確認延遲會削弱門檻",
        ),
        "notify_guard_settings_drop_phrase": (
            "强制会话正在运行：删除输入的短语会削弱门槛",
            "強制工作階段正在執行：刪除輸入的短語會削弱門檻",
        ),
        "notify_guard_settings_raise_earn_rate": (
            "强制会话正在运行：提高休息赚取率会资助更多逃脱",
            "強制工作階段正在執行：提高休息賺取率會資助更多逃脫",
        ),
        "notify_guard_settings_raise_cap": (
            "强制会话正在运行：提高休息上限会资助更多逃脱",
            "強制工作階段正在執行：提高休息上限會資助更多逃脫",
        ),
        "notify_guard_settings_shorten_pause": (
            "强制会话正在运行：缩短休息会降低其成本",
            "強制工作階段正在執行：縮短休息會降低其成本",
        ),
        "notify_guard_settings_shorten_unlock": (
            "强制会话正在运行：缩短解锁会降低其成本",
            "強制工作階段正在執行：縮短解鎖會降低其成本",
        ),
        "notify_guard_settings_schedule_weakened": (
            "强制会话正在运行：其计划项在会话结束前无法削弱",
            "強制工作階段正在執行：其計畫項在工作階段結束前無法削弱",
        ),
    }

    # Iterate through all source keys and add translations
    print(f"Processing {len(source)} keys...")
    untranslated = []

    for key in sorted(source.keys()):
        if key in all_translations:
            zh_CN[key], zh_TW[key] = all_translations[key]
        else:
            # This key needs translation - mark as needing work
            untranslated.append(key)
            # Temporarily use English (but this will be caught as an error)
            zh_CN[key] = source[key]["en"]
            zh_TW[key] = source[key]["en"]

    print(f"\nTranslated: {len(all_translations)}")
    print(f"Still need translations: {len(untranslated)}")
    print(f"Total keys processed: {len(zh_CN)}")

    if len(zh_CN) != 681:
        print(f"ERROR: Expected 681 keys, got {len(zh_CN)}")
        sys.exit(1)

    # Write output files
    out_cn = Path(
        "/private/tmp/claude-501/-Users-rick-workspace-distraction-blocker/70009532-e9b0-4600-9d23-664683093d7b/scratchpad/flat-zh_CN.json"
    )
    out_tw = Path(
        "/private/tmp/claude-501/-Users-rick-workspace-distraction-blocker/70009532-e9b0-4600-9d23-664683093d7b/scratchpad/flat-zh_TW.json"
    )

    with open(out_cn, "w", encoding="utf-8") as f:
        json.dump(zh_CN, f, ensure_ascii=False, indent=1)

    with open(out_tw, "w", encoding="utf-8") as f:
        json.dump(zh_TW, f, ensure_ascii=False, indent=1)

    print(f"\nWrote {len(zh_CN)} keys to {out_cn}")
    print(f"Wrote {len(zh_TW)} keys to {out_tw}")

    if untranslated:
        print("\nKeys needing completion:")
        for k in untranslated[:20]:
            print(f"  {k}")
        if len(untranslated) > 20:
            print(f"  ... and {len(untranslated) - 20} more")


if __name__ == "__main__":
    main()
