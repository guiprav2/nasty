# Shared fonts

Font assets live here so all Nasty language implementations can use the same files.
Ubuntu, DejaVu Sans, and Liberation Mono provide the desktop and fallback fonts
used by the original Rainbow on this Linux desktop. The adjacent license files cover redistribution.
Rainbow's original font-family stack is preserved; Inter is not bundled by its source.
Noto Color Emoji (CBDT build 2.051, from Debian's fonts-noto-color-emoji) is the color
emoji fallback; it is registered automatically for text runs that contain emoji.

Names use lowercase ASCII with whitespace replaced by underscores. Optional weight
variants use suffixes such as `_medium` and `_bold`. Select them through `style.fontFamily`.
