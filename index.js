var req = require('request');
var express = require('express');
var bodyParser = require('body-parser');
var twilio = require('twilio');
var express = require('express');
var app = express();

app.set('port', (process.env.PORT || 5000));
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
})); // support encoded bodies


var accountSid = process.env.accountSid;
var authToken = process.env.authToken;
var workspaceSid = process.env.workspaceSid;
var workflowSid = process.env.workflowSid;

var client = new twilio.TaskRouterClient(accountSid, authToken, workspaceSid);

/* the overview of this application is:
This is a state machine which uses TaskRouter as the underlying engine for an IVR. Each Queue within TaskRouter represents a node within an IVR tree
 - When a call comes in to a twilio Number, Twilio Webhooks to this application requesting TwiML instructions to the call
 - While that webhook is pending, we lookup whether a task exists for this call SID
 - If no task exists (it's a new call) then we create a task for the call. It will get routed to the default queue in the TaskRouter workflow
 - If it's an existing task we update it's attributes with the previous node step, and any DTMF entered at that step
 - Whether a new task or an updated task, we retrieve what task queue (node) the task is currently in
 - we fetch the TwiML for that given node, and reply to the webhook with that
*/





app.post('/initiateivr', function(request, response) {
	    /*  This function is triggered when any step in programmable voice triggers a webhook as part of an IVR flow.
        It:
        - fetches the TaskSID for this current call if one exists, or creates one otherwise
        - Updates the attributes for this task with the content from the webhook request (e.g. DTMF digits)
        - Fetches the new TaskQueue which the task has been routed to based on those digits
        - Fetches the TwiML for that TaskQueue
        - Responds to the webhook with that TwiML

        This method relies on a lot of asynchronous function, and uses callbacks for that. Alternatively this could
        be built with promises.
        */

    var attributesJson = {};
	
    checkForExistingTask(request.body['CallSid'], function(returnedTask){
    	//console.log(returnedTask);
    	if (!returnedTask) {
		    attributesJson['CallSid'] = request.body['CallSid'];
		    attributesJson['From'] = request.body['From'];
		    attributesJson['To'] = request.body['To'];
    		console.log("did not find an existing task for call sid " + request.body['CallSid'])
			createTask(attributesJson, function(returnedTask){
				console.log("created a new task for this call with SID " + returnedTask.sid);
				//console.log(returnedTask);
				response.send(getTwimlForTaskQueue(returnedTask));
			});
    	}
    	else {
    		console.log("existing call, call SID " + request.body['CallSid'] +" correlates to task " + returnedTask.sid);
    		console.log("Dialed digits " + request.body['Digits']);
    		attributesJson['exited_node'] = returnedTask.task_queue_friendly_name;
    		attributesJson[returnedTask.task_queue_friendly_name + '_entered_digits'] = request.body['Digits'];
    		updateTask(attributesJson, returnedTask, function(returnedTask){
	    		response.send(getTwimlForTaskQueue(returnedTask));

	    	});
    	}
    });
});

function createTask(attributesJson, fn) {
	var attributesString = JSON.stringify(attributesJson);

	var options = {
        method: 'POST',
        url: 'https://taskrouter.twilio.com/v1/Workspaces/' + workspaceSid + '/Tasks',
        auth: {
            username: accountSid,
            password: authToken
        },
        form: {
            WorkflowSid: workflowSid,
            Attributes: attributesString
        }
    };
    console.log("want to create a new task with these attributes");
    console.log(attributesString);
    req(options, function(error, response, body) {
        if (error) throw new Error(error);
        //console.log(body);
        var newTaskResponse = JSON.parse(body);
        console.log("created a new tasks with Sid " + newTaskResponse.sid);
        fn(newTaskResponse);
    });
    
}

function updateTask(attributesJson, task, fn) {
	/*
	This function will update a task with new attributes
	Note that it will append (or overwrite where keys are the same value) but will not delete existing attributes
	*/
	var mergedAttributes = {};
	var currentAttributes = JSON.parse(task.attributes);
	console.log("Updating task which has current attributes of " + task.attributes);
	for(key in currentAttributes)
	    mergedAttributes[key] = currentAttributes[key];
	for(key in attributesJson)
   		mergedAttributes[key] = attributesJson[key];
	var attributesString = JSON.stringify(mergedAttributes);

	var options = {
        method: 'POST',
        url: 'https://taskrouter.twilio.com/v1/Workspaces/' + workspaceSid + '/Tasks/'+ task.sid,
        auth: {
            username: accountSid,
            password: authToken
        },
        form: {
            Attributes: attributesString
        }
    };
    console.log("Updating the existing task with these attributes");
    console.log(attributesString);
    req(options, function(error, response, body) {
        if (error) throw new Error(error);
        //console.log(body);
        var newTaskResponse = JSON.parse(body);
        console.log("updated the task with Sid " + newTaskResponse.sid + "with attributes");
        fn(newTaskResponse);
    });
    
}

function checkForExistingTask(CallSid, fn) {
	console.log("checking for any existing task for this call SID: " + CallSid);
	var taskToReturn=false;
	var queryJson = {};
	queryJson['EvaluateTaskAttributes'] = "(CallSid=\"" + CallSid + "\")";
	client.workspace.tasks.get(queryJson, function(err, data) {
        if (!err) {
            // looping through them, but call SIDs are unique and should only ever be one task maximum 	
            // using a for loop instead of for each since we want to exit completely if we find one
            for (var i=0; i< data.tasks.length; i++) {
            	var task=data.tasks[i]
                console.log("found an existing task for this call. Trying to list attributes");
                console.log(task.attributes);
                console.log("will use this existing task sid for this conversation " + task.sid);
                taskToReturn=task;
                console.log("ONE");
                fn(taskToReturn);
                return;
            }
            console.log("TWO");
            fn(taskToReturn);
        }
        else {
        	console.log("THREE");
        	fn(taskToReturn);
        }
    });
    
}

function getTwimlForTaskQueue(task) {
	var twimlResponse="";
	 switch (task.task_queue_friendly_name) {
      case "first_node":
        twimlResponse="<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Gather timeout=\"10\" finishOnKey=\"*\"><Say>This call was routed to the first node. Please enter your zip code followed by star</Say></Gather></Response>"
        break;

     case "second_node":
        twimlResponse="<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Say>This call was routed to the second node. You entered %first_node_entered_digits%</Say></Response>"
        break;
    }
    return replaceTokensWithAttributes(twimlResponse, task);
}

function replaceTokensWithAttributes(twimlResponse, task) {
	var parsedResponse = twimlResponse.replace(/%(.*?)%/gi, function(a,b) {
		console.log("parsed Response " + parsedResponse);
		console.log("a " + a);
		console.log("b" + b);
	});
}

/* 
Functions below here are placeholders for where you could add additional logic
*/

app.get('/nodechange', function(request, response) {
    /* This function is triggered on the event when a task changes TaskQueue. TaskQueues represent individual nodes within an IVR.
    */
    if (request.body.TaskSid && request.body.EventType == "task-queue.entered") {
        console.log("task moved into new queue " + request.body.TaskQueueSid);
    }
});

/* 
functions beneath here are not core to the function and can be ignored
*/

app.get('/alive', function(request, response) {

    response.send('I AM ALIVE');
});

app.listen(app.get('port'), function() {
    console.log('Node app is running on port', app.get('port'));
});

