# Activity presentation

The activity dock displays the latest published Agent status snapshot. Lifecycle, runtime configuration, queue, selection, and attention changes refresh that snapshot through the activity source's change notifications. Editor input, resizing, theme invalidation, and animation redraw the retained snapshot without inspecting transcripts.

A new dock samples its source when installed, and disposal removes its subscription and animation timer. Active children animate between state changes; settlement stops the timer.

Presentation snapshots are transient display data. Explicit Agent status and roster observations still inspect current durable evidence. Each roster entry shares one transcript inspection across its evidence pointer, model/thinking context, and recency ordering.

Compaction is a transient human-facing activity, not a Run phase or scheduling state. While a live Agent compacts, both its dock row and the open `/agents` selector show `compacting` instead of ordinary work or waiting status. Start and end signals refresh both surfaces without reopening the selector; ending compaction reveals the current underlying status, not an assumed idle state. Native completion includes failure and cancellation, and Runtime failure or disposal clears the indicator. Lifecycle termination and failure labels take precedence.

The selector subscribes while open and removes that subscription on disposal. Refreshes preserve its selected Agent and scope.
