---
"scream-code": patch
---

Image requests no longer carry a capability claim that only some roles can honour. The image section is split by role: the main agent is told that image work stays in the conversation because only it is given `ImageGenerate` and the image configuration, and a subagent is told it has neither, with the requirement to report the need rather than substitute drawing code. The `ImageGenerate` tool description and the `designer` role carry the same rule at their own level. A profile test pins the split, since the previous wording described the capability to every role while only one profile listed the tool.
