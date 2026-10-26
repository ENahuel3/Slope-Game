# Gandalf — picture card for the Epic Sax Gandalf skyline

`gandalf.png`: a 480x840 transparent cut-out of Gandalf the Grey (Ian McKellen's film costume, full length with
staff and sword), downloaded by the owner on 2026-10-26 from
https://wallpapers.com/png/gandalfthe-wizard-full-length-portrait-163l2zmjtz8cvdl4
(file https://wallpapers.com/images/hd/gandalfthe-wizard-full-length-portrait-163l2zmjtz8cvdl4.png).
Character: The Lord of the Rings / New Line Cinema; the site lists its PNGs as free downloads.

`tools/patch_gandalf.py` trims the transparent margins, pastes the picture into a power-of-two atlas and makes the
`buildingsGandalf` skyline prefab: one upright 180-unit card per used pillar slot (every other slot of each row),
200 units from the lane centre on both sides, turned 15 degrees inward, drawn through a copy of the Mort cutout
shader (alpha below 0.25 discarded, both faces). The mod selects it through the `ModBuildingGandalf` FSM
variable while the Epic Sax Gandalf track plays.
