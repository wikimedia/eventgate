'use strict';

const kafka = require('node-rdkafka');

/**
 * This file contains two kafka.Producer sublclasses: a 'GuaranteedProducer' and a 'HastyProducer'
 * The difference between the two is the use of the delivery-report callback.
 * GuaranteedProducer will wait for a produce request to be returned from the Kafka broker
 * (inclulding retries) before resolving its Promise.  HastyProducer will resolve the produce
 * Promise as soon as node-rdkafka accepts the produce request, and not wait for the Kafka brokers
 * to ACK the result.
 */

// Originally taken from
// https://github.com/wikimedia/change-propagation/blob/06178c20779c5ff213dcfdaca92fef0072e0d469/lib/kafka_factory.js
// and
// https://github.com/wikimedia/eventgate/blob/892079f71ebce0499312b9bf09738577186b5ff6/lib/kafka.js

// rdkafka log messages come out like
// [thrd:main]:   Topic staging.test.event partition 0 Leader 1003
// Capture the thread name and the log message out of it.
const RDKAFKA_LOG_MSG_REGEX =  /^\[thrd:(.+?)\]:\s+(.*)$/;

/**
 * Maps syslog severity levels (from rdkafka) to appropriate
 * bunyan log levels.
 */
const SYSLOG_SEVERITY_TO_BUNYAN_MAP = {
    0: 'fatal',
    1: 'fatal',
    2: 'fatal',
    3: 'error',
    4: 'warn',
    5: 'info',
    6: 'debug',
    7: 'trace'
};

/**
 * Registers node-rdkafka event.error and event.log events
 * to be logged appropriately by the provided bunyan logger.
 * Log events will not be logged unless event_cb: true is set
 * in kafka client config.
 * To use this well, you should also set kafka.conf.log_level (to get rdkafka to log things)
 * and/or kafka.conf.debug: broker,topic,msg (or whatever facilities you want).
 *
 * @param {Object} kafkaClient node-rdkafka client, producer or consumer.
 * @param {Object} logger bunyan logger.
 */
function registerKafkaLogHandler(kafkaClient, logger) {
    logger.trace('Registering rdkafka log handler');

    // Log rdkafka log messages at appropriate log level.
    kafkaClient.on('event.log', (rdkafkaLog) => {
        // Parse the thread name out of the message header.
        let thread = 'unknown';
        let message = rdkafkaLog.message;

        const match = rdkafkaLog.message.match(RDKAFKA_LOG_MSG_REGEX);
        if (match && match.length === 3) {
            // Get the first matched group as the rdkafka thread name.
            thread = match[1];
            // The second match group will contain the log message.
            message = match[2];
        }
        // Log at the appropriate bunyan severity level.
        const bunyanLogLevel = SYSLOG_SEVERITY_TO_BUNYAN_MAP[rdkafkaLog.severity];
        logger[bunyanLogLevel](
            { rdkafka_facility: rdkafkaLog.fac, rdkafka_thread: thread },
            message
        );
    });

    // Log rdkafka errors at error level.
    // We wait a second before registering the error handler logger.
    // rdkafka emits a couple of harmless 'error' events during
    // initial connection to brokers that can be misleading.
    setTimeout(() => {
        kafkaClient.on('event.error', (error) => {
            logger.error({ error }, `Encountered rdkafka error event: ${error.message}`);
        });
    }, 1000);

}

/**
 * Returns a Promise of a connected Kafka Producer ready for producing.
 * A hasty producer does not use a delivery callback, and will not wait
 * for  delivery confirmation before resolving a produce promise, while
 * a guaranteed producer type will.
 *
 * @param {string} ProducerClass One of GuaranteedProducer or HastyProducer.
 * @param {Object} config  Kafka config.  Additional custom config `producer.poll.interval.ms`
 *                         controls the value used for producer.setPollInterval.
 *                         producer.poll.interval.ms defaults to 100.
 * @param {Object} topicConfig Kafka topic config.
 * @param {Object} logger bunyan logger.  If given, will be used for rdkafka event.log callback
 * @return {Promise<ProducerClass>}
 */
function producerFactory(ProducerClass, config = {}, topicConfig = {}, logger = null) {
    // Get and delete producer.poll.interval.ms from kafka conf; it is not
    // a real rdkafka config.
    const pollInterval = config['producer.poll.interval.ms'] || 100;
    delete config['producer.poll.interval.ms'];

    const producerPromise = new Promise((resolve, reject) => {
        const producer = new ProducerClass(config, topicConfig);
        producer.once('event.error', reject);

        if (pollInterval) {
            producer.setPollInterval(pollInterval);
        }

        // If given a bunyan logger, use it to log rdkafka event.log events.
        if (logger) {
            registerKafkaLogHandler(producer, logger.child({ producer_type: ProducerClass.name }));
        }

        producer.connect(undefined, (err) => {
            if (err) {
                return reject(err);
            }
            return resolve(producer);
        });
    });

    return producerPromise;
}

/**
 * Uses the node-rdkafka delivery-report callback to resolve the produce call Promise
 * based on the Kafka broker delivery status.
 */
class GuaranteedProducer extends kafka.Producer {
    /**
     * Returns a Promise of a connected Kafka GuaranteedProducer ready for producing.
     *
     * @param {Object} config  Kafka config.  Additional custom config `producer.poll.interval.ms`
     *                         controls the value used for producer.setPollInterval.
     *                         producer.poll.interval.ms defaults to 100.
     * @param {Object} topicConfig Kafka topic config.
     * @param {Object} logger bunyan logger.  If given, will be used for rdkafka event.log callback
     * @return {Promise<GuaranteedProducer>}
     */
    static factory(config = {}, topicConfig = {}, logger = null) {
        return producerFactory(GuaranteedProducer, config, topicConfig, logger);
    }

    /**
     * @inheritdoc
     */
    constructor(conf, topicConf) {
        // GuaranteedProducer required dr_cb is true to use delivery-report.
        conf.dr_cb = true;
        super(conf, topicConf);

        this.on('delivery-report', (err, report) => {
            const reporter = report.opaque;
            if (err) {
                return reporter.rejecter(err);
            }
            return reporter.resolver(report);
        });
    }

    /**
     * @inheritdoc
     */
    produce(topic, partition, message, key, timestamp) {
        return new Promise((resolve, reject) => {
            const report = {
                resolver: resolve,
                rejecter: reject
            };
            try {
                const result = super.produce(topic, partition, message, key, timestamp, report);
                if (result !== true) {
                    process.nextTick(() => {
                        reject(result);
                    });
                }
            } catch (e) {
                process.nextTick(() => {
                    reject(e);
                });
            } finally {
                // After the produce, call poll immediately to see if the produce actually finished.
                this.poll();
            }
        });
    }
}

/**
 * Resolves a produce call Promise as soon as node-rdkafka accepts the produce request.
 * This producer will not wait for a delivery report for the message.
 */
class HastyProducer extends kafka.Producer {

    /**
     * Returns a Promise of a connected Kafka HastyProducer ready for producing.
     *
     * @param {Object} config  Kafka config.  Additional custom config `producer.poll.interval.ms`
     *                         controls the value used for producer.setPollInterval.
     *                         producer.poll.interval.ms defaults to 100.
     * @param {Object} topicConfig Kafka topic config.
     * @param {Object} logger bunyan logger.  If given, will be used for rdkafka event.log callback
     * @return {Promise<Object>}
     */
    static factory(config = {}, topicConfig = {}, logger = null) {
        return producerFactory(HastyProducer, config, topicConfig, logger);
    }

    /**
     * @inheritdoc
     */
    produce(topic, partition, message, key, timestamp) {
        return new Promise((resolve, reject) => {
            try {
                const result = super.produce(topic, partition, message, key, timestamp);
                if (result !== true) {
                    reject(result);
                }
                resolve(result);
            } catch (e) {
                reject(e);
            }
        });
    }
}

module.exports = {
    GuaranteedProducer,
    HastyProducer
};
