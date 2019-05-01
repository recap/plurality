## Plurality
Plurality is a data staging service using containers to use custom protocol for data transfers between DTN (Data Transfer Nodes). 
The minimum software stack for on a DTN server is ssh and Singularity. Plurailty assumes no root access to DTN nodes and uses Singularity containers to deploy
custom data transfer protocols. 

# Setup config files
### nodes.db
This config file describes the ssh access parameters for the nodes to be accessed by the Plurality e.g. 
```
{
  "capabilities": {
    "singularity": "which singularity",
    "slurm": "which sbatch"
  },
  "hosts": [
    {
      "capabilities": {},
      "host": "HOST1",
      "keyFile": null,
      "port": 22,
      "user": "USER1",
      "dirs": [
        "/mnt/dss/dtn"
      ]
    },
    {
      "capabilities": {},
      "host": "HOST2",
      "keyFile": null,
      "port": 22,
      "user": "USER2"
    }
  ]
}
```
### protocols.db
This config file describes the container images to be used for each custom protocol e.g.
```
{
  "udt": {
    "name": "udt",
    "src": {
      "image": "recap/udt-singularity",
      "cmd": "singularity run udt.img sendfile 9000",
      "stop": "ps -C sendfile | grep -v PID | awk '{print $1}' | xargs kill -9"
    },
    "dst": {
      "image": "recap/udt-singularity",
      "cmd": "singularity run udt.img recvfile ##HOST## 9000 ##RPATH## ##LPATH##"
    }
  },
  "http": {
    "name": "http",
    "src": {
      "image": "recap/http-singularity",
      "cmd": "singularity run http.img python -m SimpleHTTPServer 8080",
      "stop": "ps -C 'python -m SimpleHTTPServer 8080' | grep -v grep | awk '{print $1}' | xargs kill -9"
    },
    "dst": {
      "image": "recap/http-singularity",
      "cmd": "singularity run http.img wget http://##HOST##:8080/##RPATH## -O ##LPATH##"
    }
  }
}
```
The above describe two protocols __udt__ and __http__ and their respective containers for sender and receiver. 
# API
* POST /api/v1/copy
submit an array of copy requests to the staging service. E.g. 
```
[{
  	  "protocol": "http",
      "src": {
        "host": "HOSTNAME",
        "path": "PATH"
      },
      "dst": {
        "host": "HOSTNAME",
        "path": "PATH"
      }
  },
  {
  	  "protocol": "udt",
      "src": {
        "host": "HOSTNAME",
        "path": "PATH"
      },
      "dst": {
        "host": "HOSTNAME",
        "path": "PATH"
      }
  }]
```
The above submits a request to copy a file using *http* and *udt* from one host to the next. 

