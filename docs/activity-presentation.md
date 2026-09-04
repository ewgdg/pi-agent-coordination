# Activity presentation

The activity dock displays the latest published Agent status snapshot. Lifecycle, runtime configuration, queue, selection, and attention changes refresh that snapshot through the activity source's change notifications. Editor input, resizing, theme invalidation, and animation redraw the retained snapshot without inspecting transcripts.

A new dock samples its source when installed, and disposal removes its subscription and animation timer. Active children animate between state changes; settlement stops the timer.

Presentation snapshots are transient display data. Explicit Agent status and roster observations still inspect current durable evidence. Each roster entry shares one transcript inspection across its evidence pointer, model/thinking context, and recency ordering.
