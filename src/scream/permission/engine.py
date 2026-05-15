"""权限规则引擎 — 基于通配符的规则匹配系统。

参考 OpenCode 的 permission 系统：
- 三级动作：allow | deny | ask
- 基于通配符的规则匹配（tool_pattern, path_pattern）
- 按 specificity 排序，最具体的规则优先
- 支持默认规则集和运行时规则叠加
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class PermissionAction(Enum):
    """权限动作。"""

    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


class PermissionResult(Enum):
    """权限评估结果。"""

    ALLOWED = "allowed"
    DENIED = "denied"
    REQUIRES_APPROVAL = "requires_approval"


@dataclass(frozen=True)
class PermissionRule:
    """单条权限规则。

    匹配逻辑：
    1. tool_pattern 匹配 action 名称（支持 * 通配符）
    2. path_pattern 匹配文件路径（可选，支持 * 通配符）
    3. 两者都匹配时规则生效

    Specificity 计算：
    - 无通配符的工具名 = 高 specificity
    - 有通配符的工具名 = 中 specificity
    - 通配符工具名 + 路径 = 高 specificity
    - 默认规则 * = 最低 specificity
    """

    tool_pattern: str
    action: PermissionAction
    path_pattern: str | None = None
    description: str = ""

    def matches(self, tool_name: str, arguments: dict[str, Any]) -> bool:
        """检查规则是否匹配。"""
        # 工具名匹配（action 名称）
        if not fnmatch.fnmatch(tool_name, self.tool_pattern):
            return False

        # 路径匹配（如果规则指定了路径模式）
        if self.path_pattern is not None:
            file_path = self._extract_path(arguments)
            if file_path is None:
                return False
            if not fnmatch.fnmatch(file_path, self.path_pattern):
                return False

        return True

    @property
    def specificity(self) -> int:
        """规则 specificity 分数（越高越优先）。"""
        score = 0

        # 工具名 specificity
        if self.tool_pattern == "*":
            score += 0
        elif "*" in self.tool_pattern:
            score += 5
        else:
            score += 10

        # 路径 specificity — 有路径约束的规则比纯工具名规则更具体
        if self.path_pattern is not None:
            if self.path_pattern == "*":
                score += 5
            elif "*" in self.path_pattern:
                score += 15
            else:
                score += 20

        return score

    @staticmethod
    def _extract_path(arguments: dict[str, Any]) -> str | None:
        """从工具参数中提取文件路径。"""
        for key in ("file_path", "path", "command", "target"):
            val = arguments.get(key)
            if isinstance(val, str):
                return val
        return None


# 内置默认规则集（适配当前 scream-code 的工具命名）
DEFAULT_RULES: list[PermissionRule] = [
    # 读取操作默认允许
    PermissionRule("read file", PermissionAction.ALLOW, description="读取文件默认允许"),
    PermissionRule("read media file", PermissionAction.ALLOW, description="读取媒体默认允许"),
    PermissionRule("glob", PermissionAction.ALLOW, description="文件搜索默认允许"),
    PermissionRule("grep", PermissionAction.ALLOW, description="代码搜索默认允许"),
    # 浏览器/搜索操作默认允许
    PermissionRule("search", PermissionAction.ALLOW, description="搜索默认允许"),
    PermissionRule("fetch", PermissionAction.ALLOW, description="网页获取默认允许"),

    # 写操作默认询问
    PermissionRule("edit file", PermissionAction.ASK, description="编辑文件需确认"),
    PermissionRule(
        "edit file outside of working directory",
        PermissionAction.ASK,
        description="编辑工作区外文件需确认",
    ),

    # 执行操作默认询问
    PermissionRule("run command", PermissionAction.ASK, description="执行命令需确认"),
    PermissionRule("run background command", PermissionAction.ASK, description="后台命令需确认"),
    PermissionRule("stop background task", PermissionAction.ASK, description="停止后台任务需确认"),
    PermissionRule("execute*", PermissionAction.ASK, description="执行操作需确认"),
    PermissionRule("shell", PermissionAction.ASK, description="Shell 命令需确认"),
    PermissionRule("install*", PermissionAction.ASK, description="安装操作需确认"),
    PermissionRule("delete*", PermissionAction.ASK, description="删除操作需确认"),

    # 敏感路径默认拒绝或询问
    PermissionRule("*", PermissionAction.ASK, path_pattern="/etc/*", description="系统目录需确认"),
    PermissionRule("*", PermissionAction.ASK, path_pattern="/usr/*", description="系统目录需确认"),
    PermissionRule("*", PermissionAction.ASK, path_pattern="/bin/*", description="系统目录需确认"),
    PermissionRule("*", PermissionAction.ASK, path_pattern="/sbin/*", description="系统目录需确认"),
    PermissionRule("*", PermissionAction.DENY, path_pattern="*.env", description="禁止环境文件"),
    PermissionRule("*", PermissionAction.DENY, path_pattern=".env*", description="禁止环境文件"),
    PermissionRule("*", PermissionAction.DENY, path_pattern="*/.env", description="禁止环境文件"),
    PermissionRule("*", PermissionAction.DENY, path_pattern="*/.env.*", description="禁止环境文件"),
    PermissionRule("*", PermissionAction.ASK, path_pattern="*/.ssh/*", description="SSH 需确认"),
    PermissionRule("*", PermissionAction.ASK, path_pattern="*/.aws/*", description="AWS 需确认"),
    PermissionRule(
        "*", PermissionAction.ASK, path_pattern="*/.scream/config.toml", description="配置需确认"
    ),

    # 通配默认规则（最低优先级）
    PermissionRule("*", PermissionAction.ASK, description="未知操作默认询问"),
]


@dataclass
class PermissionEngine:
    """权限规则引擎。

    评估流程：
    1. 按 specificity 降序排序所有规则
    2. 从最高 specificity 开始匹配
    3. 第一个匹配的规则决定结果
    4. 无匹配时返回 REQUIRES_APPROVAL
    """

    rules: list[PermissionRule] = field(default_factory=lambda: list(DEFAULT_RULES))
    _session_overrides: list[PermissionRule] = field(default_factory=list, repr=False)
    _auto_approved_tools: set[str] = field(default_factory=set, repr=False)
    _session_auto_approve: bool = False

    def evaluate(self, tool_name: str, arguments: dict[str, Any]) -> PermissionResult:
        """评估工具调用的权限。

        Returns:
            ALLOWED: 允许执行
            DENIED: 拒绝执行
            REQUIRES_APPROVAL: 需要用户确认
        """
        if self._session_auto_approve:
            return PermissionResult.ALLOWED

        if tool_name in self._auto_approved_tools:
            return PermissionResult.ALLOWED

        # 合并规则并按 specificity 排序（高优先级在前）
        all_rules = self._session_overrides + self.rules
        sorted_rules = sorted(all_rules, key=lambda r: r.specificity, reverse=True)

        for rule in sorted_rules:
            if rule.matches(tool_name, arguments):
                match rule.action:
                    case PermissionAction.ALLOW:
                        return PermissionResult.ALLOWED
                    case PermissionAction.DENY:
                        return PermissionResult.DENIED
                    case PermissionAction.ASK:
                        return PermissionResult.REQUIRES_APPROVAL

        # 无匹配规则，默认需要确认
        return PermissionResult.REQUIRES_APPROVAL

    def requires_approval(self, tool_name: str, arguments: dict[str, Any]) -> bool:
        """简化接口：检查是否需要审批。"""
        result = self.evaluate(tool_name, arguments)
        return result == PermissionResult.REQUIRES_APPROVAL

    def is_denied(self, tool_name: str, arguments: dict[str, Any]) -> bool:
        """检查是否被明确拒绝。"""
        return self.evaluate(tool_name, arguments) == PermissionResult.DENIED

    def add_rule(self, rule: PermissionRule) -> None:
        """添加规则（用户自定义，优先级高于默认规则）。"""
        self.rules.insert(0, rule)

    def add_session_rule(self, rule: PermissionRule) -> None:
        """添加临时会话规则（最高优先级）。"""
        self._session_overrides.insert(0, rule)

    def auto_approve_all(self) -> None:
        """本次会话全局自动审批。"""
        self._session_auto_approve = True

    def auto_approve_tool(self, tool_name: str) -> None:
        """自动审批指定工具（本次会话）。"""
        self._auto_approved_tools.add(tool_name)

    def reset_session(self) -> None:
        """重置会话级覆盖。"""
        self._session_overrides.clear()
        self._auto_approved_tools.clear()
        self._session_auto_approve = False

    @classmethod
    def from_dict_list(cls, rules_data: list[dict[str, Any]]) -> PermissionEngine:
        """从字典列表创建权限引擎。"""
        rules: list[PermissionRule] = []
        for r in rules_data:
            action_str = r.get("action", "ask")
            action = PermissionAction(action_str)
            rules.append(
                PermissionRule(
                    tool_pattern=r.get("tool_pattern", "*"),
                    action=action,
                    path_pattern=r.get("path_pattern"),
                    description=r.get("description", ""),
                )
            )
        return cls(rules=rules + DEFAULT_RULES)

    def to_dict_list(self) -> list[dict[str, Any]]:
        """序列化为字典列表（仅用户自定义规则）。"""
        return [
            {
                "tool_pattern": r.tool_pattern,
                "action": r.action.value,
                "path_pattern": r.path_pattern,
                "description": r.description,
            }
            for r in self.rules
            if r not in DEFAULT_RULES
        ]
