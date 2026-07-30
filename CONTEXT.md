# Live Agent Coordination

This context defines durable Agent identities and their transient live coordination within a Workflow.

## Language

**Request**:
An Agent-authored question that creates exactly one Answer obligation. A Request has one stable identity and targets either another Agent or the human.

**Agent Request**:
A Request targeting a known Agent in the same Workflow. Its Request identity is also the identity of its outbound Message.

**Human Request**:
A blocking Request targeting the human and containing one or more Human Questions. An Agent may have at most one unresolved Human Request, while different Agents may have requests open concurrently.

**Human Question**:
One independently presented prompt within a Human Request. A request-specific UI presents multiple Human Questions as tabs.

**Human Answer**:
The structured set of human responses to a Human Request's Questions, canonically bound to that exact Request. It ends the Request's protocol obligation without claiming that its content is semantically sufficient.
_Avoid_: Human Response, Agent-confirmed resolution
