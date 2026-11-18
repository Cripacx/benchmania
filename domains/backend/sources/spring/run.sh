#!/bin/sh
# Heap limited to 50 % of the container memory limit, as production images usually set it (the JDK default
# is 25 %); otherwise JVM defaults, including the default GC.
if [ "$AOTCACHE" = "1" ]; then
  exec java -XX:MaxRAMPercentage=50 -XX:AOTCache=/app/app.aot -jar /app/x/app.jar
else
  exec java -XX:MaxRAMPercentage=50 -jar /app/x/app.jar
fi
