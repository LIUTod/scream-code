from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Literal

from scream.approval_runtime import (
    ApprovalCancelledError,
    ApprovalRuntime,
    ApprovalSource,
    get_current_approval_source_or_none,
)
from scream.permission import PermissionEngine, PermissionResult
from scream.soul.toolset import get_current_tool_call_or_none
from scream.tools.utils import ToolRejectedError
from scream.utils.logging import logger
from scream.wire.types import DisplayBlock

type Response = Literal["approve", "approve_for_session", "reject"]


class ApprovalResult:
    """Result of an approval request. Behaves as bool for backward compatibility."""

    __slots__ = ("approved", "feedback")

    def __init__(self, approved: bool, feedback: str = ""):
        self.approved = approved
        self.feedback = feedback

    def __bool__(self) -> bool:
        return self.approved

    def rejection_error(self) -> ToolRejectedError:
        if self.feedback:
            return ToolRejectedError(
                message=(f"工具调用已被用户拒绝。用户反馈: {self.feedback}"),
                brief=f"已拒绝: {self.feedback}",
                has_feedback=True,
            )
        source = get_current_approval_source_or_none()
        is_subagent = source is not None and source.agent_id is not None
        if is_subagent:
            return ToolRejectedError(
                message=(
                    "工具调用已被用户拒绝。"
                    "请尝试不同的方法来完成任务，如果没有替代方案，"
                    "请在总结中说明此限制。"
                    "不要重试相同的工具调用，也不要尝试通过间接手段绕过此限制。"
                ),
            )
        return ToolRejectedError()


class ApprovalState:
    def __init__(
        self,
        yolo: bool = False,
        afk: bool = False,
        runtime_afk: bool = False,
        auto_approve_actions: set[str] | None = None,
        on_change: Callable[[], None] | None = None,
    ):
        self.yolo = yolo
        self.afk = afk
        """Persisted session flag. True when no user is present.

        Implies auto-approve and is restored with the session.
        """
        self.runtime_afk = runtime_afk
        """Invocation-only afk flag, e.g. ``--afk`` or ``--print``. Not persisted."""
        self.auto_approve_actions: set[str] = auto_approve_actions or set()
        """Set of action names that should automatically be approved."""
        self._on_change = on_change

    def notify_change(self) -> None:
        if self._on_change is not None:
            self._on_change()


class Approval:
    def __init__(
        self,
        yolo: bool = False,
        *,
        state: ApprovalState | None = None,
        runtime: ApprovalRuntime | None = None,
        permission_engine: PermissionEngine | None = None,
    ):
        self._state = state or ApprovalState(yolo=yolo)
        self._runtime = runtime or ApprovalRuntime()
        self._permission_engine = permission_engine or PermissionEngine()

    def share(self) -> Approval:
        """Create a new approval queue that shares approval state."""
        return Approval(state=self._state, runtime=self._runtime, permission_engine=self._permission_engine)

    def set_runtime(self, runtime: ApprovalRuntime) -> None:
        self._runtime = runtime

    @property
    def runtime(self) -> ApprovalRuntime:
        return self._runtime

    def set_yolo(self, yolo: bool) -> None:
        self._state.yolo = yolo
        self._state.notify_change()

    def set_afk(self, afk: bool) -> None:
        """Toggle persisted afk (away-from-keyboard) mode.

        Turning it off also clears any invocation-only afk overlay so an
        interactive session started with ``--afk`` can return to interactive
        behavior via ``/afk``.
        """
        self._state.afk = afk
        if not afk:
            self._state.runtime_afk = False
        self._state.notify_change()

    def set_runtime_afk(self, afk: bool) -> None:
        """Toggle invocation-only afk mode without persisting it."""
        self._state.runtime_afk = afk

    def is_auto_approve(self) -> bool:
        """True when tool calls should be auto-approved.

        Afk implies auto-approve, so this returns True whenever either the
        explicit yolo flag or afk is set.
        """
        return self._state.yolo or self.is_afk()

    def is_yolo(self) -> bool:
        """True only when the user explicitly opted into yolo."""
        return self._state.yolo

    def is_yolo_flag(self) -> bool:
        """True only when the user explicitly opted into yolo (not via afk)."""
        return self.is_yolo()

    def is_afk(self) -> bool:
        """True when no user is present (away-from-keyboard)."""
        return self._state.afk or self._state.runtime_afk

    def is_afk_flag(self) -> bool:
        """True only when persisted afk mode is active."""
        return self._state.afk

    def is_runtime_afk(self) -> bool:
        """True only when afk came from this invocation."""
        return self._state.runtime_afk

    async def request(
        self,
        sender: str,
        action: str,
        description: str,
        display: list[DisplayBlock] | None = None,
    ) -> ApprovalResult:
        """
        Request approval for the given action. Intended to be called by tools.

        Args:
            sender (str): The name of the sender.
            action (str): The action to request approval for.
                This is used to identify the action for auto-approval.
            description (str): The description of the action. This is used to display to the user.

        Returns:
            ApprovalResult: Result with ``approved`` flag and optional ``feedback``.
                Behaves as ``bool`` via ``__bool__``, so ``if not result:`` works.

        Raises:
            RuntimeError: If the approval is requested from outside a tool call.
        """
        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            raise RuntimeError("Approval must be requested from a tool call.")

        logger.debug(
            "{tool_name} ({tool_call_id}) requesting approval: {action} {description}",
            tool_name=tool_call.function.name,
            tool_call_id=tool_call.id,
            action=action,
            description=description,
        )
        if self.is_auto_approve():
            from scream.telemetry import track

            track(
                "tool_approved",
                tool_name=tool_call.function.name,
                approval_mode="afk" if self.is_afk() else "yolo",
            )
            return ApprovalResult(approved=True)

        if action in self._state.auto_approve_actions:
            from scream.telemetry import track

            track(
                "tool_approved",
                tool_name=tool_call.function.name,
                approval_mode="auto_session",
            )
            return ApprovalResult(approved=True)

        # PermissionEngine 评估（在展示审批 UI 前进行前置过滤）
        if self._permission_engine is not None:
            try:
                import json

                raw_args = tool_call.function.arguments
                if isinstance(raw_args, str) and raw_args:
                    arguments = json.loads(raw_args)
                elif isinstance(raw_args, dict):
                    arguments = raw_args
                else:
                    arguments = {}
            except Exception:
                arguments = {}
            result = self._permission_engine.evaluate(action, arguments)
            if result == PermissionResult.ALLOWED:
                from scream.telemetry import track

                track(
                    "tool_approved",
                    tool_name=tool_call.function.name,
                    approval_mode="permission_engine",
                )
                return ApprovalResult(approved=True)
            if result == PermissionResult.DENIED:
                from scream.telemetry import track

                track(
                    "tool_rejected",
                    tool_name=tool_call.function.name,
                    approval_mode="permission_engine",
                )
                return ApprovalResult(
                    approved=False,
                    feedback="权限引擎已拒绝此操作（匹配 DENY 规则）。",
                )
            # REQUIRES_APPROVAL → 继续展示审批 UI

        request_id = str(uuid.uuid4())
        display_blocks = display or []
        source = get_current_approval_source_or_none() or ApprovalSource(
            kind="foreground_turn",
            id=tool_call.id,
        )
        self._runtime.create_request(
            request_id=request_id,
            tool_call_id=tool_call.id,
            sender=sender,
            action=action,
            description=description,
            display=display_blocks,
            source=source,
        )
        try:
            response, feedback = await self._runtime.wait_for_response(request_id)
        except ApprovalCancelledError:
            from scream.telemetry import track

            track(
                "tool_rejected",
                tool_name=tool_call.function.name,
                approval_mode="cancelled",
            )
            record = self._runtime.get_request(request_id)
            return ApprovalResult(approved=False, feedback=record.feedback if record else "")
        from scream.telemetry import track

        match response:
            case "approve":
                track(
                    "tool_approved",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                return ApprovalResult(approved=True)
            case "approve_for_session":
                track(
                    "tool_approved",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                self._state.auto_approve_actions.add(action)
                self._state.notify_change()
                for pending in self._runtime.list_pending():
                    if pending.action == action:
                        self._runtime.resolve(pending.id, "approve")
                return ApprovalResult(approved=True)
            case "reject":
                track(
                    "tool_rejected",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                return ApprovalResult(approved=False, feedback=feedback)
            case _:
                track(
                    "tool_rejected",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                return ApprovalResult(approved=False)
