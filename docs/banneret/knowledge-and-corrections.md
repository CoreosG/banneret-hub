# Knowledge and repeated corrections

Expand Memory in an orchestrator chat and open Memory preferences. Add the absolute paths of the workspace's Markdown folders on this machine. For the Banneret knowledge checkout, choose its docs folder. Clear the paths to turn search off. Search results quote matching sections and include the folder, relative path, heading and checkout commit date when available. The index lives on this machine.

Turn on **Find repeated corrections in this orchestrator** for a local check every ten of your messages and when work ends. Agents can also raise a correction when you repeat it. This is not activity tracking. The check reads only messages you typed to your own agents. It keeps instruction sentences as evidence. It does not collect usage history, tool output, or messages from agents or other people. Matching uses words and requires no model.

The first correction stays private as a candidate. After two separate messages, the proposal card quotes the sources. Confirm or edit it to make it a rule. Dismiss hides it until you raise it again.

| State on this machine  | What changes it                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Nudge off              | Enabling starts the message count at zero. Disabling drops unprocessed sentences.                                          |
| Sentences waiting      | The tenth message or task end checks them. The queue and count survive a restart.                                          |
| Quiet candidate        | A second matching message opens a proposal. Evidence older than 90 days expires from matching.                             |
| Proposed               | A fresh matching message adds its quote. Confirm or edit accepts the note. Dismiss hides the proposal until a fresh match. |
| Search index in memory | A lookup rebuilds changed folders and checkouts. Restart clears the cache.                                                 |

## Review my workflow

Type **Review my workflow** in the main orchestrator chat or use its review button. The report reads
the workspace owner's local orchestrator records and Banneret notes. It counts retries, tool failures,
completed approval waits, proposed or disputed notes, stale notes and reminder responses. A suggested
rule enters the usual proposal queue when you choose it. The report never edits provider memory.

Under Settings → Memory, choose **Manage memory and workflow reviews**, select the main chat, and
enable **Weekly workflow review**. The shared Hub scheduler checks the saved deadline while automatic
work is running. The report and schedule live in the owner's local memory database.

| Saved state   | Event            | Result                                                      |
| ------------- | ---------------- | ----------------------------------------------------------- |
| Off (default) | Enable weekly    | First run due in seven days                                 |
| Enabled       | Deadline reached | Replace the chat report and mark one Needs you item pending |
| Enabled       | Disable weekly   | Remove the deadline                                         |
| Any           | Run on demand    | Replace the report and preserve any pending item            |
| Pending       | Mark reviewed    | Clear the item for that report                              |
| Any           | Restart          | Resume the saved deadline and pending item                  |

A public issue draft contains only the displayed title and body. Open it to review and submit on
GitHub, or copy it. In a company workspace, find a writable **#feedback** channel and press **Send
draft** to post the same text there.
