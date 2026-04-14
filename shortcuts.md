# Proposed Keyboard Shortcuts for CHAVES

To improve the terminal user experience, we should implement the following shortcuts:

## Navigation
- **Ctrl+L**: Toggle between AI Chat and Development Pane (Implemented in tmux).
- **PageUp / PageDown**: Scroll message history (Implemented).
- **Home / End**: Jump to top/bottom of message history.
- **Esc**: Reset scroll to bottom and clear unread count (Implemented).

## Editor / Input
- **Ctrl+K**: Clear current chat input or clear entire chat history (depending on context).
- **Ctrl+U**: Clear the current line of input (Standard terminal behavior).
- **Up / Down**: Navigate command history (if implemented) or move cursor in multi-line input.
- **Alt+Enter**: Insert a newline without submitting (Implemented).

## System / UI
- **Ctrl+Q / Ctrl+C**: Quit CHAVES safely.
- **Ctrl+R**: Force refresh / re-index current file changes.
- **Ctrl+T**: Cycle through available themes.
- **Ctrl+H**: Toggle a help overlay showing all shortcuts.

## Channel Filters (Advanced)
- **Alt+1**: Show all messages (Default).
- **Alt+2**: Show only Chat messages.
- **Alt+3**: Show only Proactive Insights.
- **Alt+4**: Show only Terminal Logs.
