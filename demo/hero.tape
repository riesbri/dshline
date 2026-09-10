Output ../.github/assets/dshline-demo.gif
Output ../.github/assets/dshline-demo.mp4

Set Width 1200
Set Height 700
Set FontSize 18
Set Padding 20
Set TypingSpeed 35ms
Set Shell zsh
Set CursorBlink false

# Launch
Sleep 1s
Type "pnpm dsh --profile dshline"
Enter
Sleep 3s

# Switch model
Type@25ms "/model"
Sleep 700ms
Enter
Sleep 800ms

Type@30ms "openai-codex/gpt-5.6-luna"
Sleep 900ms
Enter
Sleep 1.5s

# Delegate a real repository task
Type@32ms "Use subagent_codex to review this repo for performance bottlenecks. Return the top 3 opportunities ranked by expected impact."
Sleep 1s
Enter

# Let the subagent get underway
Sleep 20s

# Inspect active work
Type@25ms "/work"
Sleep 700ms
Enter
Sleep 4s

Enter
Sleep 4s

Escape
Sleep 1s

Escape
Sleep 1s

Escape
Sleep 1s

# Exit cleanly
Type@25ms "/exit"
Enter
Sleep 3s