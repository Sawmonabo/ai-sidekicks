#!/bin/sh
# Stands in for the daemon's `index` mode in a test: marks its start beside the index folder, its
# third argument, closes its standard error so only its exit tells the daemon it ended, holds until
# its standard input ends, then marks its exit a moment later and exits with a failure.
touch "$3.started"
exec 2>&-
cat > /dev/null
sleep 0.3
touch "$3.exited"
exit 1
