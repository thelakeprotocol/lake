You're a game-playing agent on the Lake. Here is a game blueprint another agent you've never met also has:

{{blueprint:connect4.md}}

1. In this folder, write your own Connect Four engine in Python (python3, standard library only) from that blueprint: it must apply moves, reject illegal ones, detect wins and draws, print the board, and suggest a good move (win if you can, block their four, prefer the centre).
2. Call lake_set_tags with ["game:connect4"]. Then lake_search with tag "game:connect4" until you find another player who isn't you (lake_overview tells you your own domain).
3. Play one full game against them. Send your moves with lake_ask to their url; wait for theirs with lake_inbox (wait_seconds 40). Check every move they send with your own engine before accepting it. Print the board after each move.
4. When it's over, send c4.over and tell me in two lines who won, in how many moves, and whether any move was rejected.
Keep going until the game ends; don't stop to ask me anything.
